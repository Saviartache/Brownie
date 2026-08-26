/**
 * Damaging ground, not admitted to — for a few seconds at a time.
 *
 * `GROUNDDAMAGE` is client→server: standing in lava is something only the
 * *client* knows, so the client is what tells the server it happened. Withhold
 * that and the damage does not arrive.
 *
 * **But not for long.** The server tolerates roughly ten seconds of a character
 * standing in damaging ground saying nothing about it, and then drops the
 * connection. So the refusal is a window rather than a switch — and one that
 * **recharges on its own**: it holds for a few seconds, lets exactly one
 * admission through, and opens again from that moment. Standing in lava
 * therefore costs one tick of damage every few seconds instead of one twice a
 * second, and the server hears from the character on every cycle, far inside
 * the ten seconds it waits.
 *
 * `lavaWindow.ts` is the rule, and a countdown over the character says how much
 * of the current window is left, in the same floating text noclip's budget uses
 * and for the same reason: a hold that is on a clock has to be readable at a
 * glance from inside the game.
 *
 * ## Why this one works when the others did not
 *
 * This is the surviving half of a much larger attempt at not being hit, and it
 * survived because a live session showed it working while everything beside it
 * did not. The full list, and what each measured:
 *
 * | tried | measured result |
 * |---|---|
 * | Shrink the shot's collision square, or the player's | damage still landed |
 * | Withhold `PLAYERHIT` | damage still landed |
 * | Forge the client's "invulnerable" condition bits locally | damage still landed |
 * | Report the character standing somewhere else | damage still landed, and the player's own shots stopped landing |
 * | Answer nought in the client's damage arithmetic | damage still landed |
 * | Decline the client's damage-application method outright | **40 applications declined in one session; health still dropped** |
 * | Send `SETCONDITION` claiming Invulnerable | accepted without complaint and ignored — no `FAILURE`, no effect |
 * | Drop `ENEMYSHOOT` so no bullet is built | **kicked** — the server tracks the shots it fired |
 * | **Withhold `GROUNDDAMAGE`** | **tile damage stopped** |
 *
 * One rule explains every row: **the server refuses the client's word about
 * things it can work out for itself, and depends on it for things it cannot.**
 * It simulates its own bullets against the position you report, so a refused
 * `PLAYERHIT` costs it nothing. It does not know which tile you are standing on
 * until you say so, so a refused `GROUNDDAMAGE` costs it the hit — and a
 * refusal it never hears the end of costs it the whole conversation, which is
 * what the window is for.
 *
 * The two decisive rows are the sixth and the seventh. Declining the client's
 * damage application *worked* — forty times, counted — and the health bar came
 * down regardless, which is the direct measurement that the client is not what
 * subtracts it. And `SETCONDITION` is the client's own sanctioned way to tell
 * the server an effect is on the character; the server took it and did nothing,
 * so it is not a channel for asserting state either.
 *
 * The recovered code says the same thing independently: the local player's
 * health is never *decremented* in the client. It is **assigned**, by two
 * `void(int)` setters on the character base — `EEBDHHBHJHL` and `MBKGLHCJBCD`
 * in this build — which is what a value fed from the server's stat stream looks
 * like. There is no local "subtract damage from me" step to hook.
 *
 * ## What that leaves, and where it is
 *
 * Two damage kinds are gated on the client's acknowledgement and both can be
 * refused: **damaging ground**, which is this plugin, and **area effects**,
 * which the collider plugin already withholds `AOEACK` for. Anything a
 * projectile does is simulated server-side and cannot be refused — the answer
 * to that one is not being there, which is what `features/dodge` is, and not
 * dying, which is what `features/autonexus` is.
 *
 * ## What this deliberately does not offer
 *
 * A switch for `PLAYERHIT`, and one for `SETCONDITION`. Each is one line and
 * each would look like the same feature, and neither changes anything in this
 * build — a switch that says it protects you while the health bar keeps
 * dropping is worse than no switch at all. Auto-nexus still drops `PLAYERHIT`
 * when a hit would be lethal, which is a different claim: it is *escaping*,
 * not surviving.
 */

import { PluginCategory, definePlugin, type Plugin, type Unsubscribe } from '@brownie/plugin-api';
import type { HoldColour } from '../noclip/holdBudget.js';
import { MAX_HOLD_SECONDS, countdownFor, windowFor } from './lavaWindow.js';

/** The one thing this needs that the plugin surface does not carry. */
export interface HazardGuardOutput {
  /**
   * Shows a line over the player, in the game's own floating text.
   *
   * The same output noclip takes, and for the same reason: a refusal that is on
   * a clock has to say how much of the clock is left without the player looking
   * away from the fight.
   */
  showText(text: string, colour: HoldColour): void;
}

/**
 * How often the countdown is redrawn. One second, because that is the
 * resolution it is read at.
 */
const TICK_MS = 1000;

/** How long a window lasts by default, in seconds. */
const DEFAULT_HOLD_SECONDS = 3;

/**
 * How long a gap counts as the character having walked out, in milliseconds.
 *
 * Damaging ground reports itself about twice a second while it is stood on, so
 * anything much beyond one of those gaps is the character having left. Too
 * short and a stutter in the stream opens a second window while the character
 * never moved — which is the one way this feature could exceed the server's
 * patience by accident.
 */
const DEFAULT_REARM_MS = 1500;

export function createHazardGuardPlugin(output: HazardGuardOutput): Plugin {
  return definePlugin({
    meta: {
      id: 'hazard-guard',
      name: 'Hazard Guard',
      category: PluginCategory.Combat,
      description: 'Withholds damaging-ground reports for a few seconds at a time.',
    },

    setup(context) {
      const holdSeconds = context.settings.range('holdSeconds', {
        label: 'Withhold for (seconds)',
        default: DEFAULT_HOLD_SECONDS,
        min: 1,
        // **The ceiling is the server's patience, not a preference.** Past
        // about ten seconds of silence while stood in damaging ground the
        // connection is dropped, so the slider cannot be dragged into one.
        max: MAX_HOLD_SECONDS,
        step: 1,
      });
      const rearmMs = context.settings.range('rearmMs', {
        label: 'Count as having walked out after (ms)',
        advanced: true,
        default: DEFAULT_REARM_MS,
        min: 500,
        max: 5000,
        step: 100,
      });

      /** When the last admission arrived, and when the open window started. */
      let lastGroundAtMs: number | undefined;
      let openedAtMs: number | undefined;
      /** How the countdown is stopped, and nothing while it is not running. */
      let stopTicking: Unsubscribe | undefined;

      const stopCountdown = (): void => {
        stopTicking?.();
        stopTicking = undefined;
      };

      // **Draws, and owns nothing.** The window is the packet handler's, and a
      // ticker that also closed it would be a second writer racing the first —
      // which with a recharging window is the difference between "taking one"
      // and taking every one.
      const tick = (): void => {
        if (openedAtMs === undefined) {
          stopCountdown();
          return;
        }
        const line = countdownFor(Date.now() - openedAtMs, holdSeconds.get());
        output.showText(line.text, line.colour);
        if (line.spent) {
          // Said once, then the ticker rests. The next admission is what
          // recharges the window, and reopening the countdown is its job — so
          // a character that walked out during this second leaves nothing
          // ticking behind it.
          stopCountdown();
        }
      };

      /**
       * **The ticker starts with the window, not with the plugin.**
       *
       * Registered once at setup it would run on a schedule of its own, and a
       * window opening at some arbitrary point in that second would show its
       * first number a fraction of a second later — `3s left`, then `3s left`
       * again, then `2s`. A countdown that repeats a number reads as one that
       * is stuck. Started here, every line lands a whole second after the one
       * before it, and nothing ticks while nothing is being withheld.
       */
      const openCountdown = (): void => {
        stopCountdown();
        const line = countdownFor(0, holdSeconds.get());
        output.showText(line.text, line.colour);
        stopTicking = context.timers.setInterval(tick, TICK_MS);
      };

      const forget = (): void => {
        lastGroundAtMs = undefined;
        openedAtMs = undefined;
        stopCountdown();
      };

      // A window belonged to the ground the character was standing on, and a
      // map change means they are not standing on it any more.
      context.packets.on('MAPINFO', forget);
      context.onDispose(context.sessions.onConnected(forget));
      context.onDispose(forget);

      // **An ordinary `on`, deliberately.** Auto-nexus reads this packet on
      // `onFirst` to charge the tile against its simulated health and to escape
      // when it would be lethal, so running after it is what leaves that
      // feature's estimate intact. A dropped packet still reaches every later
      // handler with the verdict it has, so nothing downstream is blinded
      // either: this refuses the report, it does not hide it.
      context.packets.on('GROUNDDAMAGE', (packet) => {
        const now = Date.now();
        const state = windowFor(
          now,
          lastGroundAtMs,
          openedAtMs,
          holdSeconds.get() * 1000,
          rearmMs.get(),
        );
        lastGroundAtMs = now;
        openedAtMs = state.openedAtMs;

        // A window that opened — whether by walking in or by recharging after
        // the last one was spent — restarts the countdown from a whole second.
        if (state.opened) openCountdown();
        if (state.withhold) packet.drop();
        // Otherwise it goes through, and that is the point rather than a
        // failure: one tick of damage every few seconds is what buys the
        // silence either side of it. The window has already reopened.
      });
    },
  });
}
