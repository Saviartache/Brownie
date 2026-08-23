/**
 * Oryx's Sanctuary: withholds the hit reports the fight punishes.
 *
 * The client decides its own bullet collisions and reports them with
 * `ENEMYHIT`. Three Sanctuary mechanics answer such a report with a penalty
 * rather than damage, so declining one is a matter of not sending it — which is
 * the whole of this plugin. Which reports those are, and the evidence behind
 * each number, is {@link punishedHits}.
 *
 * **It reads the world model rather than the packet stream.** The implementation
 * this came from hooked `UPDATE` and `NEWTICK` to learn the object ids of the
 * boss, the artifacts and the chancellor, and to re-scan the stat block for the
 * guard on every tick. The state stage has already done all of that before any
 * plugin runs, and it holds every stat the server sent — so the id in the hit
 * report is enough to ask what was hit and what phase it is in. That leaves one
 * map lookup per hit and nothing at all per tick.
 *
 * ## The treasure shuffle is off by default, and that is deliberate
 *
 * One of the three artifacts is the one to hit; the others punish. The game
 * says which by flashing it, through `SHOWEFFECT` — whose body is described now,
 * so the object it names is readable; what nobody here has established is which
 * effect type on which object marks the safe one, and that is a question about
 * the mechanic rather than about the packet. Until somebody watches one,
 * switching the rule on withholds hits on **all three**, including the right
 * one, which is a real cost and not a safety margin. It is
 * offered because avoiding the penalty is sometimes worth it, and defaulted off
 * because a switch that quietly stops the player damaging the mechanic is not
 * something to turn on for them.
 *
 * The other two rules cost nothing when they fire: a hit on a guarded Oryx and
 * a hit on a speaking chancellor do no damage either way.
 */

import {
  PluginCategory,
  definePlugin,
  type EntityView,
  type Plugin,
  type SessionView,
  type SettingHandle,
} from '@brownie/plugin-api';
import {
  ANIMATION_STAT,
  CHANCELLOR_DAMMAH,
  DAMMAH_MONOLOGUE,
  DAMMAH_SPEAKER,
  ORYX_GUARD_ANIMATIONS,
  ORYX_THE_MAD_GOD_3,
  TREASURE_ARTIFACTS,
  punishmentFor,
  type Punishment,
  type PunishedHitRules,
} from './punishedHits.js';

/**
 * Everything one connection remembers, which is one phase and the map it
 * belongs to.
 *
 * The map name is re-checked on the way in rather than reset from a `MAPINFO`
 * handler: a plugin's handlers do not run while it is switched off, so a map
 * change during that time would otherwise never be noticed and the chancellor's
 * phase would carry into a fight it has nothing to do with.
 */
interface SanctuaryState {
  mapName: string;
  dammahSpeaking: boolean;
}

const NO_RULES: PunishedHitRules = {
  oryxGuard: false,
  dammahMonologue: false,
  treasureShuffle: false,
};

export function createSanctuaryPlugin(): Plugin {
  return definePlugin({
    meta: {
      id: 'oryx-sanctuary',
      name: "Oryx's Sanctuary",
      category: PluginCategory.Combat,
      description: 'Withholds the hits the Sanctuary punishes instead of counting as damage.',
    },

    setup(context) {
      const oryxGuard = context.settings.boolean('oryxGuard', {
        group: 'Withhold hits on',
        label: 'Oryx, while he is guarded',
        default: true,
      });

      const dammahMonologue = context.settings.boolean('dammahMonologue', {
        group: 'Withhold hits on',
        label: 'Chancellor Dammah, while he is speaking',
        default: true,
      });

      const treasureShuffle = context.settings.boolean('treasureShuffle', {
        group: 'Withhold hits on',
        // Stated on the control itself, because it is the one rule here with a
        // cost: nothing on the wire says which artifact is the right one.
        label: 'Every treasure artifact — including the one worth hitting',
        default: false,
      });

      const switches: readonly SettingHandle<boolean>[] = [
        oryxGuard,
        dammahMonologue,
        treasureShuffle,
      ];

      // Folded when a switch moves rather than read per hit: a Sanctuary run
      // reports thousands of them and none of this is rediscovered by one.
      let rules: PunishedHitRules = NO_RULES;
      let anyRule = false;

      const refresh = (): void => {
        rules = {
          oryxGuard: oryxGuard.get(),
          dammahMonologue: dammahMonologue.get(),
          treasureShuffle: treasureShuffle.get(),
        };
        anyRule = rules.oryxGuard || rules.dammahMonologue || rules.treasureShuffle;
      };

      refresh();
      for (const handle of switches) context.onDispose(handle.onChange(refresh));

      const bySession = new Map<string, SanctuaryState>();

      const stateFor = (session: SessionView): SanctuaryState => {
        const mapName = session.world.mapName;
        const held = bySession.get(session.id);
        if (held === undefined) {
          const fresh: SanctuaryState = { mapName, dammahSpeaking: false };
          bySession.set(session.id, fresh);
          return fresh;
        }
        if (held.mapName !== mapName) {
          held.mapName = mapName;
          held.dammahSpeaking = false;
        }
        return held;
      };

      /** How many hits each rule has withheld, for `/o3`. Per session. */
      const withheld = new Map<Punishment, number>();

      context.packets.on('ENEMYHIT', (packet, session) => {
        if (!anyRule) return;
        if (packet.opaque) return;

        const targetId = packet.number('targetId');
        if (targetId === undefined) return;

        // The state stage runs ahead of every plugin, so whatever was hit is
        // already in the world with its latest stats. An id the world does not
        // hold is something that left view between the client deciding and the
        // report arriving, and nothing here has an opinion about it.
        const target = session.world.entity(targetId);
        if (target === undefined) return;

        // Asked only of the chancellor: his is the one rule whose answer is not
        // on the entity, and every other hit would pay for the lookup.
        const dammahSpeaking =
          target.objectType === CHANCELLOR_DAMMAH && stateFor(session).dammahSpeaking;

        const punishment = punishmentFor(target, dammahSpeaking, rules);
        if (punishment === undefined) return;

        packet.drop();
        withheld.set(punishment, (withheld.get(punishment) ?? 0) + 1);
      });

      // Tracked whether or not the rule is on, so switching it on mid-fight
      // acts on the phase the chancellor is actually in rather than on a
      // default the plugin never had a chance to correct.
      context.packets.on('TEXT', (packet, session) => {
        if (packet.opaque) return;
        if (packet.string('name') !== DAMMAH_SPEAKER) return;
        // Negative fame is how this game marks a speaker that is not a player.
        const stars = packet.number('numStars');
        if (stars === undefined || stars > -1) return;

        const state = stateFor(session);
        const speaking = DAMMAH_MONOLOGUE.has(packet.string('cleanText') ?? '');
        if (speaking === state.dammahSpeaking) return;

        state.dammahSpeaking = speaking;
        context.log.debug(`Dammah ${speaking ? 'started' : 'finished'} speaking`);
      });

      context.commands.register({
        name: 'o3',
        description: "Report what Oryx's Sanctuary tracking currently sees.",
        run: (_args, session) => {
          session.notify(report(session, stateFor(session).dammahSpeaking, withheld));
        },
      });

      // Per session, like the runtime's other counters: what is worth reading is
      // what this character has withheld, not what an earlier connection did.
      context.onDispose(
        context.sessions.onConnected(() => {
          withheld.clear();
        }),
      );
      context.onDispose(
        context.sessions.onDisconnected((session) => {
          bySession.delete(session.id);
        }),
      );
      context.onDispose(() => {
        bySession.clear();
        withheld.clear();
      });
    },
  });
}

/** What the fight looks like from here, for one line in the game's chat box. */
function report(
  session: SessionView,
  dammahSpeaking: boolean,
  withheld: ReadonlyMap<Punishment, number>,
): string {
  let oryx: EntityView | undefined;
  let dammah: EntityView | undefined;
  let artifacts = 0;

  for (const entity of session.world.entities()) {
    if (entity.objectType === ORYX_THE_MAD_GOD_3) oryx = entity;
    else if (entity.objectType === CHANCELLOR_DAMMAH) dammah = entity;
    else if (TREASURE_ARTIFACTS.has(entity.objectType)) artifacts++;
  }

  const parts: string[] = [`map "${session.world.mapName}"`];

  if (oryx !== undefined) {
    // The raw value, not just the verdict: it is the only thing that says
    // whether stat 125 is the animation this reads it as. See `punishedHits`.
    const animation = oryx.stat(ANIMATION_STAT);
    const guarded = animation !== undefined && ORYX_GUARD_ANIMATIONS.has(animation);
    const shown = animation === undefined ? 'none' : String(animation);
    parts.push(`Oryx id=${String(oryx.objectId)} animation=${shown}${guarded ? ' GUARDED' : ''}`);
  }
  if (artifacts > 0) parts.push(`${String(artifacts)} treasure artifacts`);
  if (dammah !== undefined) {
    parts.push(`Dammah id=${String(dammah.objectId)}${dammahSpeaking ? ' SPEAKING' : ''}`);
  }
  if (oryx === undefined && dammah === undefined && artifacts === 0) {
    parts.push('nothing of the Sanctuary in view');
  }

  const counts = [...withheld]
    .sort(([, a], [, b]) => b - a)
    .map(([punishment, count]) => `${punishment} ${String(count)}`)
    .join(', ');
  parts.push(counts === '' ? 'withheld nothing this session' : `withheld ${counts}`);

  return `Oryx's Sanctuary — ${parts.join(' | ')}`;
}
