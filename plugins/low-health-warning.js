// @ts-check
/**
 * Says something when health drops past a threshold.
 *
 * The first plugin, and deliberately a small one. It exercises the whole loop —
 * a setting reaches the overlay and comes back, a handler reads live state, the
 * plugin can be enabled and disabled without a restart, and saving this file
 * reloads it mid-session. Every packet the game sends passes through untouched;
 * the only thing injected is a line of chat, toward the client, which never
 * reaches the server.
 *
 * Something that acts on the game itself comes later, and will be easier to
 * trust for having this one work first.
 *
 * **Plain JavaScript, not TypeScript.** The runtime is plain Node with no
 * transpiler, and the loader takes `.js` and `.mjs` — a plugin is a file the
 * user edits and saves, not a build artefact.
 *
 * **`@ts-check` is not decoration.** The first version of this file read
 * `threshold.value`, and `SettingHandle` has no such property — so the
 * comparison was against `undefined`, which is false for every number, and the
 * warning could not fire at any threshold. Nothing said so: it is a plain `.js`
 * file, and a mistyped API in one is a handler that quietly does nothing. The
 * types are already published for the editor's sake; this makes `npm run check`
 * read them too.
 */

import { definePlugin, PluginCategory } from '@brownie/plugin-api';

export default definePlugin({
  meta: {
    id: 'low-health-warning',
    name: 'Low Health Warning',
    category: PluginCategory.Utility,
    description: 'Logs a line when health falls below a share of the maximum.',
  },

  setup(context) {
    const threshold = context.settings.range('thresholdPercent', {
      label: 'Warn below (% health)',
      default: 40,
      min: 5,
      max: 95,
      step: 5,
    });

    // Edge-triggered, not level-triggered. Health arrives on every tick, so a
    // plain comparison would say the same thing several times a second for as
    // long as the player stayed hurt — and noise is what makes a warning easy
    // to miss when it finally matters.
    let wasBelow = false;

    context.packets.on('NEWTICK', (_packet, session) => {
      const self = session.self;
      if (self.maxHp <= 0) return;

      const share = (self.hp / self.maxHp) * 100;
      const below = share < threshold.get();

      // Into the game's own chat, not the console. A warning the player has to
      // alt-tab to read is a warning they will not read, and the runtime's log
      // is behind the game window at the moment it matters most.
      if (below && !wasBelow) {
        session.notify(
          `Low health warning — you are at ${Math.round(self.hp)} / ${Math.round(self.maxHp)} HP (${Math.round(share)}%).`,
        );
      }
      wasBelow = below;
    });

    // Reset per session rather than carrying the last one's state: a fresh
    // character at full health should be able to trigger the first warning.
    context.sessions.onConnected(() => {
      wasBelow = false;
    });
  },
});
