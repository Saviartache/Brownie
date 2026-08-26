/**
 * Collider manipulation: the local player's collision circle, scaled down.
 *
 * **One number on one object, and the client does the rest.**
 * `collisionRadiusMultiplier` is what the client scales the player's collision
 * circle by, so a smaller value leaves local collision tests with less to hit.
 * Area damage has a separate protocol path: the client reports a landed effect
 * with `AOEACK`, and the server applies damage from that report. The packet
 * handler below withholds that acknowledgement when protection is enabled. The
 * native write itself is in `apps/native/src/game/PlayerCollision.h`; this
 * plugin owns both parts of the feature.
 *
 * **The claim expires, like player noclip's and for the same reason.** A plugin
 * can be disabled, can fail, can be unloaded, and the runtime behind it can be
 * killed — and none of those say so. So the claim is restated once a second
 * while this is enabled, the module gives it three, and the module puts the
 * game's own value back when it runs out. Switching the plugin off is therefore
 * a restore a few seconds later; unloading it is one immediately.
 *
 * **The number goes out ahead of the claim, and only when it has moved.** The
 * module applies whatever it was last told, so a claim heard before the number
 * it applies is a claim on the previous one — but a number that has not changed
 * is one the module already has, and the runtime replays every key it holds
 * whenever the link comes back. So the second message is the ordering, not the
 * repetition.
 *
 * **The reference implementation's warning did not come over, because here it
 * would be false.** It advised keeping the multiplier under 0.70 or "the auto
 * dodge becomes dangerous", which followed from its planner assuming the
 * shrunken hitbox. This planner does not: it plans against the game's full
 * collision half-extent — see `features/dodge/hitbox.ts` — so a smaller collider
 * is margin the planner never spends, and a multiplier near 1 buys nothing
 * rather than risking anything.
 */

import { PluginCategory, definePlugin, type Plugin } from '@brownie/plugin-api';

/** The claim, and the number it applies. Both are read by `Engine::AcceptFeature`. */
const FEATURE_KEY = 'player.collider';
const MULTIPLIER_KEY = 'player.colliderMultiplier';

/**
 * The health bar, painted by the module, and what to paint it with.
 *
 * **A sign rather than a feature of its own.** Nothing about the collision
 * circle is visible: a player with no hitbox looks exactly like a player with
 * one until something fails to hit them, and by then it is too late to notice
 * the switch was off. So the bar says which it is, in something no state of the
 * game paints it, and it says it for as long as the claim below is live — see
 * `game::HealthBarTint` for how the module paints it.
 */
const TINT_KEY = 'scene.healthBarTint';
const TINT_COLOUR_KEY = 'scene.healthBarTintColour';

/**
 * The sign: a cycle through every hue rather than any one colour.
 *
 * **A single colour is one the bar might have worn anyway.** The game paints it
 * green, amber and red as health drains, so a violet bar is a bar at some
 * health somebody has to know the shade of — while no state of the game walks
 * it through the whole wheel. The cycle itself is the module's, and it has to
 * be: a colour that moves every frame sent over the link would be a message a
 * frame. See `RainbowColour` in `apps/native/src/core/Colour.h`.
 *
 * One of the two spellings that key reads, and anything else is dropped rather
 * than guessed at, because a sign read wrong looks like a feature that worked.
 */
const NO_HITBOX_SIGN = 'rainbow';

/**
 * How often the claim is restated. The second player noclip restates on, and
 * the module's lease is three of these — so a late turn of the loop does not
 * put the collider back under somebody who is using it.
 */
const TICK_MS = 1000;

export function createColliderPlugin(): Plugin {
  return definePlugin({
    meta: {
      id: 'player-collider',
      name: 'Collider Manipulation',
      // Filed by what it protects against rather than where the native field is
      // stored. Neither half changes movement or wall collision.
      category: PluginCategory.Combat,
      description: 'Shrinks the local collider and blocks area-hit reports.',
    },

    setup(context) {
      // The whole circle rather than part of one, and it is the same claim on
      // the same field — a multiplier of nought. A switch rather than "drag the
      // slider to zero" because it is the thing people actually want, and
      // because a slider left at zero reads as a slider nobody finished moving.
      //
      // Named for what it does to the local circle. It is not a wall clip, and
      // area-hit reports are handled separately below.
      const noHitbox = context.settings.boolean('noHitbox', {
        label: 'No hitbox',
        default: false,
      });
      const multiplier = context.settings.range('multiplier', {
        label: 'Collision radius multiplier',
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.05,
        // Hidden rather than disabled, which is this overlay's exception and
        // the case it exists for: while the circle is gone entirely there is no
        // fraction of one to choose.
        visibleWhen: { key: 'noHitbox', equals: [false] },
      });
      const blockAreaDamage = context.settings.boolean('blockAreaDamage', {
        label: 'Block throwable and area damage',
        default: true,
      });

      // Collider scaling does not control the acknowledgement used for area
      // damage. Withholding it covers thrown bombs as well as other area effects.
      context.packets.on('AOEACK', (packet) => {
        if (blockAreaDamage.get()) packet.drop();
      });

      /**
       * What the module was last told to scale by.
       *
       * The claim is restated every second because it expires; the number is
       * not, because it does not. The module keeps what it was last told and
       * the runtime replays every key it holds whenever the link comes back —
       * so restating a number that has not moved would be one message a second
       * with no reader.
       */
      let sent: number | undefined;

      /** Whether the module was last told to paint the bar with the sign. */
      let signing = false;

      const claim = (): void => {
        const gone = noHitbox.get();
        const value = gone ? 0 : multiplier.get();
        // Before the claim, always: a claim the module heard first would be a
        // claim on the last number it happened to hold.
        if (value !== sent) {
          context.native.setFeature(MULTIPLIER_KEY, value);
          sent = value;
        }
        context.native.setFeature(FEATURE_KEY, true);

        if (gone) {
          // The sign once, ahead of the claim that applies it, for the same
          // reason the multiplier goes first. The claim itself is restated on
          // every tick, because it is the same kind of lease as the collider's.
          if (!signing) {
            context.native.setFeature(TINT_COLOUR_KEY, NO_HITBOX_SIGN);
            signing = true;
          }
          context.native.setFeature(TINT_KEY, true);
          return;
        }
        if (signing) {
          // Said rather than left to lapse, unlike everything else here: three
          // seconds of a bar still wearing the sign after the switch went off
          // reads as a switch that did not work.
          signing = false;
          context.native.setFeature(TINT_KEY, false);
        }
      };

      // Answered now rather than on the next tick: a slider whose result
      // arrives a second after it is dragged is one nobody can aim. Gated,
      // because a setting changed on a disabled plugin is not a claim.
      const answerNow = (): void => {
        if (context.enabled) claim();
      };
      context.onDispose(multiplier.onChange(answerNow));
      context.onDispose(noHitbox.onChange(answerNow));

      // The heartbeat, and the whole of the switch: the host runs this only
      // while the plugin is enabled, so switching it off is what stops the
      // claim being restated, and the module's lease is what ends it.
      context.timers.setInterval(claim, TICK_MS);

      // Unloading can say so, so it does — the lease is the safety net for the
      // ways that cannot.
      context.onDispose(() => {
        context.native.setFeature(FEATURE_KEY, false);
        if (signing) context.native.setFeature(TINT_KEY, false);
      });
    },
  });
}
