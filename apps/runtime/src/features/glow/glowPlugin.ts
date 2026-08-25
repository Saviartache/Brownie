/**
 * Glow: puts a glow of your own colour around your own character.
 *
 * **The whole of it happens in the injected module**, and it has to. The client
 * decides a character's glow colour by picking one of a handful of styles built
 * into `GameAssembly.dll`, and the two a packet can reach are a fixed red and a
 * fixed purple — no stat carries a colour, so no packet can ask for one. What
 * the module does instead is switch the game's own "this character glows" flag
 * on for the local player and repaint the style that flag selects. See
 * `PlayerGlow.h`.
 *
 * Nothing here talks to the server, and nothing here rewrites a packet. The
 * flag is a client-side field no packet carries and the style is a client-side
 * object, so the server is never told and no other player's client is either.
 *
 * **The claim is a lease.** The module gives it three seconds and this restates
 * it every second, so switching the plugin off, unloading it, or the runtime
 * dying all end the same way — the module puts the flag and the colour back. A
 * disabled plugin stops restating, which is the switch; `onDispose` says so
 * outright as well, because three seconds of a glow that was switched off reads
 * as a switch that did not work.
 */

import { PluginCategory, definePlugin, type Plugin } from '@brownie/plugin-api';
import { normaliseGlowColour } from './glowColour.js';

const FEATURE_KEY = 'player.glow';
const COLOUR_KEY = 'player.glowColour';
const CLAIM_INTERVAL_MS = 1000;

/** The game's own glow, so an untouched setting looks like the game's did. */
export const DEFAULT_GLOW_COLOUR = '#ff0000ff';

export function createGlowPlugin(): Plugin {
  return definePlugin({
    meta: {
      id: 'glow',
      name: 'Glow',
      // A repaint of what this client draws and nothing else, which is where
      // the skin changer and the health bar's tint are filed too.
      category: PluginCategory.Visuals,
      description: 'Draws a glow of your own colour around your character, in this client only.',
    },

    setup(context) {
      const colour = context.settings.text('colour', {
        label: 'Colour (#rrggbb or #rrggbbaa)',
        default: DEFAULT_GLOW_COLOUR,
        // Nine characters is the longest spelling there is; a longer value is
        // not a colour and the setting should not let one be typed.
        maxLength: 9,
      });

      /**
       * What the module was last told to paint with.
       *
       * The claim is restated every second because it expires; the colour is
       * not, because it does not. The module keeps what it was last told and
       * the runtime replays every key it holds whenever the link comes back, so
       * restating a colour that has not moved would be one message a second
       * with no reader.
       */
      let sent: string | undefined;
      /** The last text refused, so one typo is one line in the log. */
      let refused: string | undefined;

      const claim = (): void => {
        const typed = colour.get();
        const wanted = normaliseGlowColour(typed);
        if (wanted === undefined) {
          if (refused !== typed) {
            refused = typed;
            context.log.warn(
              `glow: "${typed}" is not a colour like ${DEFAULT_GLOW_COLOUR}; keeping the last one`,
            );
          }
        } else {
          refused = undefined;
          // Before the claim, always: a claim the module heard first would be a
          // claim on the last colour it happened to hold.
          if (wanted !== sent) {
            context.native.setFeature(COLOUR_KEY, wanted);
            sent = wanted;
          }
        }
        context.native.setFeature(FEATURE_KEY, true);
      };

      // Answered now rather than on the next tick: a colour that arrives a
      // second after it is typed is one nobody can compare against another.
      // Gated, because a setting changed on a disabled plugin is not a claim.
      context.onDispose(
        colour.onChange(() => {
          if (context.enabled) claim();
        }),
      );

      // The heartbeat, and the whole of the switch: the host runs this only
      // while the plugin is enabled, so switching it off is what stops the
      // claim being restated.
      context.timers.setInterval(claim, CLAIM_INTERVAL_MS);

      context.onDispose(() => {
        context.native.setFeature(FEATURE_KEY, false);
      });
    },
  });
}
