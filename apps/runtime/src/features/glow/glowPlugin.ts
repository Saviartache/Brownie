/**
 * Glow: puts a coloured glow around your own character.
 *
 * Nothing here talks to the server. The two stats the client reads when it
 * decides what glow to draw are rewritten inside the `UPDATE` and `NEWTICK`
 * packets on their way to the game, on the local player's record only, so the
 * glow exists purely in this client — other players see nothing, and the server
 * is never told anything it did not say first.
 *
 * Which stats, and what goes in them, is {@link resolveGlowTargets}; how a
 * value is held and later put back is {@link StatOverrides}. This file is the
 * wiring: the settings, one state per session, and the two handlers.
 *
 * One thing to know before changing it: putting a stat back is itself a
 * rewrite, so it needs a packet to ride on. Setting the mode to Off restores on
 * the next tick that carries the player's status, which is nearly every tick.
 * Switching the *plugin* off stops the handlers instead, so the last value
 * stays on screen until the client rebuilds the character — Off is the way to
 * clear the glow, and disabling is not.
 */

import {
  PluginCategory,
  definePlugin,
  type MutablePacket,
  type Plugin,
  type SessionView,
} from '@brownie/plugin-api';
import type { FieldValue } from '@brownie/protocol';
import { StatOverrides, asStatus, statusOfEntity, type MutableStatus } from './StatOverrides.js';
import {
  DEFAULT_GLOW_STAT,
  DEFAULT_SUPPORTER_STAT,
  GlowMode,
  LEAVE_ALONE,
  resolveGlowTargets,
} from './glowModes.js';

export function createGlowPlugin(): Plugin {
  return definePlugin({
    meta: {
      id: 'glow',
      name: 'Glow',
      // A rewrite of what this client draws and nothing else, which is where
      // anti-lag and anti-debuffs are filed too.
      category: PluginCategory.Visuals,
      description: 'Draws a coloured glow around your own character, in this client only.',
    },

    setup(context) {
      const mode = context.settings.select<GlowMode>('mode', {
        group: 'Glow',
        label: 'Glow',
        default: GlowMode.Red,
        options: [
          [GlowMode.Off, 'Off'],
          [GlowMode.Red, 'Red'],
          [GlowMode.Purple, 'Purple'],
          [GlowMode.Custom, 'Custom values'],
        ],
      });

      // The supporter stat is a tier index and the client picks a colour per
      // tier, so colours with no preset here — yellow among them — are reached
      // by stepping this value: 1, 2, 3 …
      const customGlow = context.settings.number('customGlow', {
        group: 'Custom',
        label: 'Glow stat value (-1 leaves it alone)',
        default: LEAVE_ALONE,
        min: LEAVE_ALONE,
        step: 1,
        visibleWhen: { key: 'mode', equals: [GlowMode.Custom] },
      });

      const customSupporter = context.settings.number('customSupporter', {
        group: 'Custom',
        label: 'Supporter stat value (-1 leaves it alone)',
        default: LEAVE_ALONE,
        min: LEAVE_ALONE,
        step: 1,
        visibleWhen: { key: 'mode', equals: [GlowMode.Custom] },
      });

      // Stat ids move between game versions, and neither of these is named in
      // `stat-types.json` — so retarget here rather than editing the feature.
      const glowStatId = context.settings.number('glowStatId', {
        group: 'Stat ids',
        label: 'Glow stat id',
        advanced: true,
        default: DEFAULT_GLOW_STAT,
        min: 0,
        step: 1,
      });

      const supporterStatId = context.settings.number('supporterStatId', {
        group: 'Stat ids',
        label: 'Supporter stat id',
        advanced: true,
        default: DEFAULT_SUPPORTER_STAT,
        min: 0,
        step: 1,
      });

      let targets = resolveGlowTargets({
        mode: mode.get(),
        glowStatId: glowStatId.get(),
        supporterStatId: supporterStatId.get(),
        customGlow: customGlow.get(),
        customSupporter: customSupporter.get(),
      });

      const refresh = (): void => {
        targets = resolveGlowTargets({
          mode: mode.get(),
          glowStatId: glowStatId.get(),
          supporterStatId: supporterStatId.get(),
          customGlow: customGlow.get(),
          customSupporter: customSupporter.get(),
        });
      };

      for (const handle of [mode, customGlow, customSupporter, glowStatId, supporterStatId]) {
        context.onDispose(handle.onChange(refresh));
      }

      const bySession = new Map<string, StatOverrides>();

      const stateFor = (session: SessionView): StatOverrides => {
        let state = bySession.get(session.id);
        if (state === undefined) {
          state = new StatOverrides();
          bySession.set(session.id, state);
        }
        return state;
      };

      /**
       * @returns the state to use, or `undefined` when there is nothing to
       *   write and nothing outstanding to put back.
       */
      const workFor = (session: SessionView): StatOverrides | undefined => {
        const state = bySession.get(session.id);
        if (targets.size > 0) return state ?? stateFor(session);
        return state?.active === true ? state : undefined;
      };

      /**
       * The whole of both handlers: the same work on a differently named field.
       *
       * The gates come before the packet is touched at all. Once the client has
       * been told, a tick has nothing to write — and that is the case this
       * plugin spends nearly all of its time in.
       */
      const rewrite = (
        packet: MutablePacket,
        field: 'newObjs' | 'statuses',
        session: SessionView,
        announced: boolean,
      ): void => {
        if (packet.opaque) return;
        const state = workFor(session);
        if (state === undefined) return;

        const selfObjectId = session.self.objectId;
        // Negative until `CREATESUCCESS` names us — the state layer's "no
        // player yet", and not a value any status carries.
        if (selfObjectId < 0) return;

        const entries = packet.get(field);
        if (!Array.isArray(entries)) return;
        const status = findSelfStatus(entries, selfObjectId, announced);
        if (status === undefined) return;
        if (!state.applyTo(status, targets, announced)) return;

        // Editing in place tells the pipeline nothing. Setting the field is
        // what marks the packet for re-encoding.
        packet.set(field, entries);
      };

      context.packets.on('UPDATE', (packet, session) => {
        rewrite(packet, 'newObjs', session, true);
      });

      context.packets.on('NEWTICK', (packet, session) => {
        rewrite(packet, 'statuses', session, false);
      });

      context.onDispose(
        context.sessions.onDisconnected((session) => {
          bySession.delete(session.id);
        }),
      );
      context.onDispose(() => {
        bySession.clear();
      });
    },
  });
}

/**
 * @param announced true for `UPDATE.newObjs`, whose elements are entities
 *   wrapping a status; false for `NEWTICK.statuses`, whose elements are the
 *   statuses themselves.
 */
function findSelfStatus(
  entries: readonly FieldValue[],
  selfObjectId: number,
  announced: boolean,
): MutableStatus | undefined {
  for (const entry of entries) {
    const status = announced ? statusOfEntity(entry) : asStatus(entry);
    // One status per object, so the first match is the only one there is.
    if (status?.objectId === selfObjectId) return status;
  }
  return undefined;
}
