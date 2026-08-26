/**
 * Projectile manipulation: the shots aimed at the player, built harmless.
 *
 * **The sibling of the collider plugin, on the other side of the same test.**
 * That one shrinks the player's own collision circle; this one goes to each
 * *shot* instead. Which matters because of how this client decides a hit:
 * every tick, a projectile hands its own position, its own size and its own
 * "who may I hurt" flags to a Burst job, gets back one object id or `-1`, and
 * only then reports anything. The player's circle is not in that job. The
 * shot's size is.
 *
 * So the three things worth changing all live on the projectile, and the native
 * half writes them as the shot is built — see
 * `apps/native/src/game/ProjectileShield.h`, which has the evidence and the
 * lifetimes. This file owns the choice between them and the claim that keeps
 * one live.
 *
 * ## The three modes
 *
 * | mode | what the native half writes | what the server hears |
 * |---|---|---|
 * | Shrink | the collision half-extent, scaled | nothing |
 * | Disarm | `damagesPlayers = 0` | nothing |
 * | Redirect | `damagesPlayers = 0`, `damagesEnemies = 1` | **a hit report it has never seen before** |
 *
 * Shrink and disarm arrive at the same place by different routes and neither
 * says anything to the server: a shot that finds nobody is a shot the client
 * has nothing to report, which is the same silence as a shot that flew past.
 * Shrink is the graduated one — it is the only mode that can be *partial*, and
 * a multiplier of nought is the whole hitbox gone. Disarm is the flat one, and
 * it leaves the shot its real size for anything else that reads it.
 *
 * **Redirect is not a third flavour of the same thing.** Turning a monster's
 * shot on the monsters means the client eventually reports hitting one — naming
 * a bullet the server knows that monster fired. Nothing here has seen how this
 * build's server answers a sentence the client would never otherwise say, and
 * the two answers it has for a packet it dislikes are an empty `FAILURE` and a
 * closed connection. It is offered because it was asked for, it is behind its
 * own choice, and it is not the default.
 *
 * ## What this does not cover
 *
 * Only projectiles. Area effects come down a different path entirely — the
 * client reports where the player was with `AOEACK` and the server applies the
 * damage from that report — and that half belongs to the collider plugin, which
 * already withholds it. Damaging ground is `GROUNDDAMAGE`, and nothing but
 * auto-nexus touches it. Both are deliberate: this plugin manipulates shots,
 * and a plugin that quietly reached into two more protocol paths would be one
 * nobody could reason about from its name.
 *
 * ## "Silent" means the client says nothing, not that nothing can be noticed
 *
 * Worth stating plainly, because it is the difference between what this is and
 * what it would be nice for it to be. Two things are known about this build's
 * server and neither is settled by anything here:
 *
 * * **Some damage does not need the client at all.** Anti-debuffs recorded a
 *   live session in which `Stunned` landed with no shot announced, no hit, no
 *   blast and no ground — the server's own simulation, and nothing on the wire
 *   to refuse. Whatever arrives that way still arrives.
 * * **A shot the server is carrying that is never acknowledged is a fact about
 *   the session.** The client normally answers for the bullets it was told
 *   about; a client that answers for none of them is describing a player
 *   nothing has hit for as long as the switch is on. Whether this build looks
 *   at that, and what it does if it does, has not been measured — see the same
 *   note under `features/antidebuff`, where refusing hits demonstrably worked
 *   as code and did not deliver what it promised.
 *
 * So: this removes the client's reason to report a hit. It does not make the
 * player unhittable in the server's model, and nothing in this file claims to.
 *
 * ## The claim expires, like the collider's and for the same reason
 *
 * A plugin can be disabled, can fail, can be unloaded, and the runtime behind
 * it can be killed — and none of those say so. So the claim is restated once a
 * second while this is enabled and the module gives it three. **This is the one
 * lease in the module whose lapse makes the player mortal again**, which is the
 * direction to fail in: what a forgotten claim leaves behind is the game.
 */

import { PluginCategory, definePlugin, type Plugin } from '@brownie/plugin-api';

/** The claim, and the two values it applies. All read by `Engine::AcceptFeature`. */
const FEATURE_KEY = 'shots.shield';
const MODE_KEY = 'shots.shieldMode';
const MULTIPLIER_KEY = 'shots.shieldMultiplier';

/**
 * The modes, spelled the way the module reads them.
 *
 * The same strings the setting stores, sent as they are: a mode is a key rather
 * than an index, so a build that adds one in the middle cannot silently turn a
 * shrink into a redirect. `FeatureShieldMode` in `Engine.cpp` refuses any other
 * spelling rather than guessing — a mode read wrong is one somebody has to live
 * through.
 */
const Mode = {
  Shrink: 'shrink',
  Disarm: 'disarm',
  Redirect: 'redirect',
} as const;

type Mode = (typeof Mode)[keyof typeof Mode];

/**
 * How often the claim is restated. The second the collider restates on, and the
 * module's lease is three of these — so a late turn of the loop does not put
 * the hitboxes back under somebody who is standing in a boss.
 */
const TICK_MS = 1000;

export function createShotShieldPlugin(): Plugin {
  return definePlugin({
    meta: {
      id: 'shot-shield',
      name: 'Projectile Manipulation',
      // Filed beside the collider, by what it protects against rather than by
      // where the native writes land.
      category: PluginCategory.Combat,
      description: 'Takes the hitbox off the shots aimed at the player, as they are fired.',
    },

    setup(context) {
      const mode = context.settings.select<Mode>('mode', {
        label: 'What to do with incoming shots',
        default: Mode.Shrink,
        options: [
          [Mode.Shrink, 'Shrink their hitbox'],
          [Mode.Disarm, 'Stop them looking for players'],
          [Mode.Redirect, 'Turn them on their own side (risky)'],
        ],
      });

      const multiplier = context.settings.range('multiplier', {
        label: 'Shot hitbox multiplier',
        // Nought rather than a fraction: the whole hitbox gone is what this is
        // for, and a plugin that had to be dragged to zero before it did
        // anything would be one that reads as broken on the first try. A
        // fraction is the deliberate choice, not the default one.
        default: 0,
        min: 0,
        max: 1,
        step: 0.05,
        // Hidden rather than disabled, which is this overlay's exception: the
        // other two modes have no fraction of a hitbox to choose.
        visibleWhen: { key: 'mode', equals: [Mode.Shrink] },
      });

      /**
       * What the module was last told.
       *
       * The claim is restated every second because it expires; these are not,
       * because they do not. The module keeps what it was last told and the
       * runtime replays every key it holds whenever the link comes back — so
       * restating a value that has not moved would be one message a second with
       * no reader.
       */
      let sentMode: Mode | undefined;
      let sentMultiplier: number | undefined;

      const claim = (): void => {
        // Both values before the claim, always: a claim the module heard first
        // would be a claim on whatever it happened to be holding. The
        // multiplier goes before the mode for the same reason one level down —
        // a shrink published ahead of the number it scales by would shrink one
        // volley by the number before it.
        const scale = multiplier.get();
        if (scale !== sentMultiplier) {
          context.native.setFeature(MULTIPLIER_KEY, scale);
          sentMultiplier = scale;
        }
        const chosen = mode.get();
        if (chosen !== sentMode) {
          context.native.setFeature(MODE_KEY, chosen);
          sentMode = chosen;
        }
        context.native.setFeature(FEATURE_KEY, true);
      };

      // Answered now rather than on the next tick: a mode whose result arrives
      // a second after it is chosen is one nobody can aim. Gated, because a
      // setting changed on a disabled plugin is not a claim.
      const answerNow = (): void => {
        if (context.enabled) claim();
      };
      context.onDispose(mode.onChange(answerNow));
      context.onDispose(multiplier.onChange(answerNow));

      // The heartbeat, and the whole of the switch: the host runs this only
      // while the plugin is enabled, so switching it off is what stops the
      // claim being restated, and the module's lease is what ends it.
      context.timers.setInterval(claim, TICK_MS);

      // Unloading can say so, so it does — the lease is the safety net for the
      // ways that cannot.
      context.onDispose(() => {
        context.native.setFeature(FEATURE_KEY, false);
      });
    },
  });
}
