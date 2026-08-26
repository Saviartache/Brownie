/**
 * Player noclip.
 *
 * **What it is for is the things standing on the map** — the trees and the like
 * a player has to walk around — rather than the walls of a dungeon, which are
 * the server's opinion as much as the client's.
 *
 * **Two halves, and neither works alone.** The module silences the client's own
 * walkability check, so the player walks where the client would have stopped
 * them; the server keeps its own idea of where they are and pulls them back,
 * which is the rubber-banding that makes the first half useless on its own. So
 * while noclip is on this holds the whole socket, in both directions, and the
 * server is never told about the move.
 *
 * **Both directions, because half a hold is not a hold.** Holding only what the
 * client sends leaves the server still talking, and what it is saying is where
 * it thinks the player is — so the correction lands on screen regardless, and
 * the client answers every one of those ticks into a queue that then has to be
 * flushed. The reference implementation held both, the same lag switch its
 * socket plugin used, and this is that.
 *
 * **Held, not dropped, and that is the correction this file was built on.** The
 * first version dropped the client's `MOVE` packets, which looked like the same
 * thing and was not: `MOVE` is how the client answers each server tick, and it
 * carries that tick's number. Dropping them leaves a gap in the numbers, and the
 * first one to arrive after the hold is a tick the server was not waiting for —
 * so switching noclip *off* kicked you off the server, every time. Holding the
 * socket and letting it go in order leaves no gap: the server hears every tick,
 * late and all at once. This is what the reference implementation did, and now
 * it is clear why it did it.
 *
 * **That is not free, which is what the rest of this file is about.** A server
 * that has heard nothing for long enough drops the connection anyway. So the
 * hold is on a budget, a countdown in the game's own floating text says what is
 * left of it, and when it runs out the plugin switches itself off. The reference
 * implementation put the limit at twenty seconds from having been dropped past
 * it.
 *
 * **The module's half is a claim that expires.** `setFeature` is restated on
 * every tick rather than sent once, because a plugin can be switched off,
 * unloaded or killed with the runtime behind it — and every one of those would
 * otherwise leave a game whose player walks through walls with nothing left to
 * say stop. The module gives the claim a few seconds and drops it on its own.
 * Switching off says so immediately; the rest is the safety net.
 */

import { PluginCategory, definePlugin, type Plugin, type Unsubscribe } from '@brownie/plugin-api';
import { holdState, SPENT_COLOUR, type HoldColour } from './holdBudget.js';

/**
 * The feature key the module listens for. It is a lease, not a flag — see the
 * note above and `Engine::AcceptFeature`.
 */
const FEATURE_KEY = 'player.noclip';

/**
 * How often the claim is restated, the countdown redrawn and the budget
 * checked. One second, because that is the resolution the countdown is read at
 * and there is nothing here that wants a finer one.
 */
const TICK_MS = 1000;

/** The two things this needs that the plugin surface does not carry. */
export interface NoclipOutput {
  /**
   * Shows a line over the player, in the game's own floating text.
   *
   * Text and colour only: which of the game's floating-text kinds to draw is
   * not the runtime's to say, and briefly was — a setting for a number nobody
   * could know. The module copies the kind the game itself last used.
   */
  showText(text: string, colour: HoldColour): void;

  /**
   * Holds everything the session carries, in both directions, or lets it go.
   *
   * Not a packet handler's job, and deliberately not on the plugin surface: it
   * is the whole socket, in order, and letting it go is a burst both ends have
   * to accept. See `ProxySession.holdTraffic`.
   */
  holdSocket(held: boolean): void;
}

export function createNoclipPlugin(output: NoclipOutput): Plugin {
  return definePlugin({
    meta: {
      id: 'player-noclip',
      name: 'Player Noclip',
      category: PluginCategory.Movement,
      description: 'Walks through what stands on the map, holding the socket while it does.',
      // The setting, not the switch. A plugin cannot see its own switch move,
      // and this one has to let go of the client's socket when it stops — so
      // what a key moves is the control that has a listener behind it.
      bindable: 'active',
    },

    setup(context) {
      const active = context.settings.boolean('active', {
        label: 'Noclip',
        default: false,
      });
      // Capped at the twenty seconds the reference implementation found, rather
      // than merely defaulted to it: a longer hold is not a setting somebody
      // wants, it is a disconnection they have not had yet.
      const budgetSeconds = context.settings.range('holdSeconds', {
        label: 'Hold the socket for (s)',
        default: 20,
        min: 1,
        max: 20,
        step: 1,
      });

      /** When the hold started, or nothing when there is no hold. */
      let heldSince: number | undefined;
      /** How the countdown is stopped, and nothing while it is not running. */
      let stopTicking: Unsubscribe | undefined;

      const claim = (on: boolean): void => {
        context.native.setFeature(FEATURE_KEY, on);
      };

      const say = (state: { text: string; colour: HoldColour }): void => {
        output.showText(state.text, state.colour);
      };

      const tick = (): void => {
        if (heldSince === undefined) return;

        const state = holdState(Date.now() - heldSince, budgetSeconds.get());
        if (state.spent) {
          // Through the setting rather than through `stop` directly, so the
          // overlay's switch shows what actually happened. Its listener is what
          // releases the hold.
          active.set(false);
          say({ text: state.text, colour: SPENT_COLOUR });
          context.log.info('noclip switched itself off: the hold budget is spent');
          return;
        }

        // Restated while it is wanted. This is also what makes an interval that
        // stops running — a plugin switched off, a runtime that died — enough
        // to switch the module's half off too.
        claim(true);
        say(state);
      };

      /**
       * **The ticker starts with the hold, not with the plugin.**
       *
       * Registered once at setup, it ran on a schedule of its own, and switching
       * noclip on at some arbitrary point in that second meant the first tick
       * arrived a fraction of a second later — `20s left`, then `20s left`
       * again, then `19s`. A countdown that repeats a number reads as one that
       * is stuck. Started here, every tick lands a whole second after the line
       * before it, and the timer is not running at all while nothing is held.
       */
      const start = (): void => {
        if (heldSince !== undefined) return;
        heldSince = Date.now();
        output.holdSocket(true);
        claim(true);
        say(holdState(0, budgetSeconds.get()));
        stopTicking = context.timers.setInterval(tick, TICK_MS);
      };

      // **The socket is let go before the claim is dropped, not after.**
      // Releasing is what puts the client's own account of where it walked back
      // on the wire; the module's half staying on for another frame changes
      // nothing the server can see. The other order would send that burst while
      // the client was already walking normally again.
      const stop = (): void => {
        if (heldSince === undefined) return;
        heldSince = undefined;
        stopTicking?.();
        stopTicking = undefined;
        output.holdSocket(false);
        claim(false);
      };

      active.onChange((on) => {
        if (on) start();
        else stop();
      });

      // A hold that outlived the session it was holding is a hold on nothing,
      // and the next session would start with the budget already spent.
      context.sessions.onDisconnected(() => {
        if (heldSince !== undefined) active.set(false);
      });

      // Unloading is one of the ways the countdown stops without the budget
      // being spent, and the only one that can say so.
      context.onDispose(() => {
        stop();
      });
    },
  });
}
