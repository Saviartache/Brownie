/**
 * Anti-lag: trims what the game client has to simulate and draw, purely by
 * rewriting the server→client stream. Four levers, all optional:
 *
 *   1. **size** — rewrite stat 2 for you, other players and pets.
 *   2. **hide** — size 0, or strip the object from `UPDATE.newObjs` and from
 *      `NEWTICK` statuses so the client never creates it at all.
 *   3. **shots** — drop `ALLYSHOOT`, which is what spawns other players'
 *      projectiles. Automatic whenever other players are hidden: invisible
 *      shooters firing visible bullets is never what was wanted, and in
 *      "remove" mode the owner object does not exist client-side.
 *   4. **effects** — drop `SHOWEFFECT` by type for everyone, or scoped to the
 *      ones teammates cause, and the `NOTIFICATION` popups that go with them.
 *      The scoped filters read a target object id out of a body no schema
 *      describes (see {@link TargetIdProbe}) and stay idle until that layout is
 *      known, so a boss telegraph is never dropped on a guess.
 *
 * **Nothing here changes what the runtime tracks.** The state stage runs ahead
 * of every plugin, so the world model always sees the untouched packet;
 * filtering changes what the client renders and nothing else. Nor does any of
 * it reach the native module: this feature is a stream rewrite, and adding an
 * IPC hop to say what the packet already says would be pure cost.
 *
 * **What it deliberately does not touch** is `SERVERPLAYERSHOOT`. It carries
 * shots the client acknowledges through `SHOOTACKCOUNTER`, so dropping ally
 * ability and minion shots there risks a server-side desync — the frame rate is
 * not worth a disconnect.
 *
 * One thing to know before changing this file: objects removed from the stream
 * stay removed until the next map change, because the only packet that would
 * re-announce one is the `UPDATE` that already went past. Switching the plugin
 * off brings back everything that is still being resized, not what is gone.
 */

import { PluginCategory, definePlugin, type Plugin, type SessionView } from '@brownie/plugin-api';
import { HEADER_BYTES, type FieldValue } from '@brownie/protocol';
import { SessionEntities } from './SessionEntities.js';
import { TargetIdProbe } from './TargetIdProbe.js';
import {
  ALLY_SUPPORT_EFFECTS,
  DEFAULT_BLOCKED_EFFECTS,
  blocks,
  parseEffectTypes,
} from './effectTypes.js';
import {
  AllyEffectMode,
  EntityKind,
  MAX_SIZE_PERCENT,
  MIN_SIZE_PERCENT,
  PetMode,
  PlayerMode,
  resolvePolicy,
  withoutEntityLevers,
  type AntiLagPolicy,
  type AntiLagSettings,
} from './policy.js';
import { PRESETS, presetMatches, type AntiLagPresetValues, type PresetChoice } from './presets.js';
import { asStatus, objectIdOf, statusOfEntity } from '../../state/statEdit.js';
import { StatusOutcome, rewriteStatus } from './statusRewrite.js';

/**
 * What the composition root hands over.
 *
 * Whether an object type is a pet lives in the game's own `objects.xml`, which
 * is not on the plugin surface — the same reason auto-aim is handed its
 * projectile lookup. Without game data every answer is "no", and the pet levers
 * simply do nothing rather than acting on a guess.
 */
export interface AntiLagGameData {
  isPet(objectType: number): boolean;
}

export function createAntiLagPlugin(gameData: AntiLagGameData): Plugin {
  return definePlugin({
    meta: {
      id: 'anti-lag',
      name: 'Anti-lag',
      category: PluginCategory.Visuals,
      description:
        'Hides what the client would otherwise draw: allies, pets, their shots and effects.',
    },

    setup(context) {
      // Registration order is the order the overlay draws them: presets first,
      // then the big levers, then the fine tuning.
      const preset = context.settings.select<PresetChoice>('preset', {
        group: 'Preset',
        label: 'Preset',
        default: 'custom',
        options: [
          ['custom', 'Custom (your own mix)'],
          ['off', 'Off — nothing hidden'],
          ['effects', 'Fewer particles — block heavy effects'],
          ['crowded', 'Crowded maps — small allies, no ally shots, no pets'],
          ['max', 'Maximum FPS — remove allies, pets and their shots'],
        ],
      });

      const hideAllies = context.settings.select<PlayerMode>('hideAllies', {
        group: 'Other players',
        label: 'Other players',
        default: PlayerMode.Off,
        options: [
          [PlayerMode.Off, 'Show normally'],
          [PlayerMode.Invisible, 'Invisible (still in the world)'],
          [PlayerMode.Remove, 'Remove from the world (best FPS)'],
        ],
      });

      const petHide = context.settings.select<PetMode>('petHide', {
        group: 'Other players',
        label: 'Pets on the ground',
        default: PetMode.Off,
        options: [
          [PetMode.Off, 'Show normally'],
          [PetMode.AllyFirst, "Hide other players' pets, keep yours"],
          [PetMode.All, 'Hide all pets (yours too)'],
          [PetMode.Remove, 'Remove all pets from the world (best FPS)'],
        ],
      });

      const exemptGuildmates = context.settings.boolean('exemptGuildmates', {
        group: 'Other players',
        label: 'Never hide or resize guildmates',
        default: false,
      });

      const hideAllyNotifications = context.settings.boolean('hideAllyNotifications', {
        group: 'Other players',
        label: 'Hide heal numbers and status popups from other players',
        default: false,
      });

      const hideAllyProjectiles = context.settings.boolean('hideAllyProjectiles', {
        group: 'Projectiles',
        label: "Hide other players' shots (automatic when they are hidden)",
        default: false,
      });

      const allyEffects = context.settings.select<AllyEffectMode>('allyEffects', {
        group: 'Effects',
        label: 'Ability effects from other players',
        default: AllyEffectMode.Off,
        options: [
          [AllyEffectMode.Off, 'Show normally'],
          [AllyEffectMode.Support, 'Hide their heals and buff auras'],
          [AllyEffectMode.All, 'Hide every effect they cause'],
        ],
      });

      const blockShowEffect = context.settings.boolean('blockShowEffect', {
        group: 'Effects',
        label: 'Block heavy effects from everyone (beams, novas, streams)',
        default: false,
      });

      const blockedEffectTypes = context.settings.text('blockedEffectTypes', {
        group: 'Effects',
        label: 'Blocked effect types (names or 0–255 ids, comma separated)',
        advanced: true,
        default: DEFAULT_BLOCKED_EFFECTS,
        visibleWhen: { key: 'blockShowEffect', equals: [true] },
      });

      const sizeScaling = context.settings.boolean('sizeScaling', {
        group: 'Size',
        label: 'Resize players by percentage',
        default: false,
      });

      const playerSize = context.settings.range('playerSize', {
        group: 'Size',
        label: 'Your size (%, 0 hides you)',
        default: 100,
        min: MIN_SIZE_PERCENT,
        max: MAX_SIZE_PERCENT,
        step: 5,
        visibleWhen: { key: 'sizeScaling', equals: [true] },
      });

      const allySize = context.settings.range('allySize', {
        group: 'Size',
        label: 'Other players size (%, 0 hides them)',
        default: 100,
        min: MIN_SIZE_PERCENT,
        max: MAX_SIZE_PERCENT,
        step: 5,
        visibleWhen: { key: 'sizeScaling', equals: [true] },
      });

      // ── Settings, resolved once per change ────────────────────────────────

      const readSettings = (): AntiLagSettings => ({
        playerMode: hideAllies.get(),
        petMode: petHide.get(),
        exemptGuildmates: exemptGuildmates.get(),
        scaleSizes: sizeScaling.get(),
        selfPercent: playerSize.get(),
        otherPercent: allySize.get(),
        dropAllyShots: hideAllyProjectiles.get(),
        allyEffects: allyEffects.get(),
        hideAllyNotifications: hideAllyNotifications.get(),
        blockedEffects: blockShowEffect.get()
          ? parseEffectTypes(blockedEffectTypes.get())
          : undefined,
      });

      const initial = readSettings();
      let normalPolicy = resolvePolicy(initial);
      let petYardPolicy = resolvePolicy(withoutEntityLevers(initial));
      /**
       * Bumped on every change, and compared against by each session.
       *
       * A counter rather than a callback per session: the classification caches
       * a session holds are only wrong once the settings behind them move, and
       * this is how a session notices on its next packet without anything
       * having to walk the session list.
       */
      let generation = 0;

      const refresh = (): void => {
        const settings = readSettings();
        normalPolicy = resolvePolicy(settings);
        petYardPolicy = resolvePolicy(withoutEntityLevers(settings));
        generation++;
      };

      // ── Presets ──────────────────────────────────────────────────────────

      const readPresetValues = (): AntiLagPresetValues => ({
        hideAllies: hideAllies.get(),
        hideAllyProjectiles: hideAllyProjectiles.get(),
        petHide: petHide.get(),
        allyEffects: allyEffects.get(),
        hideAllyNotifications: hideAllyNotifications.get(),
        blockShowEffect: blockShowEffect.get(),
        sizeScaling: sizeScaling.get(),
        playerSize: playerSize.get(),
        allySize: allySize.get(),
      });

      let applyingPreset = false;

      const applyPreset = (choice: PresetChoice): void => {
        if (choice === 'custom') return; // the user's own mix — nothing to apply
        const values = PRESETS[choice];
        applyingPreset = true;
        try {
          hideAllies.set(values.hideAllies);
          hideAllyProjectiles.set(values.hideAllyProjectiles);
          petHide.set(values.petHide);
          allyEffects.set(values.allyEffects);
          hideAllyNotifications.set(values.hideAllyNotifications);
          blockShowEffect.set(values.blockShowEffect);
          sizeScaling.set(values.sizeScaling);
          playerSize.set(values.playerSize);
          allySize.set(values.allySize);
        } finally {
          applyingPreset = false;
        }
        refresh();
        context.log.info(`preset "${choice}" applied`);
      };

      /** Every non-preset setting runs this. */
      const onSettingChanged = (): void => {
        refresh();
        if (applyingPreset) return;
        const current = preset.get();
        // The mix no longer matches the preset it came from, so stop claiming
        // it does rather than showing a label that lies.
        if (current !== 'custom' && !presetMatches(readPresetValues(), PRESETS[current])) {
          preset.set('custom');
        }
      };

      context.onDispose(preset.onChange(applyPreset));
      context.onDispose(hideAllies.onChange(onSettingChanged));
      context.onDispose(petHide.onChange(onSettingChanged));
      context.onDispose(exemptGuildmates.onChange(onSettingChanged));
      context.onDispose(hideAllyNotifications.onChange(onSettingChanged));
      context.onDispose(hideAllyProjectiles.onChange(onSettingChanged));
      context.onDispose(allyEffects.onChange(onSettingChanged));
      context.onDispose(blockShowEffect.onChange(onSettingChanged));
      context.onDispose(blockedEffectTypes.onChange(onSettingChanged));
      context.onDispose(sizeScaling.onChange(onSettingChanged));
      context.onDispose(playerSize.onChange(onSettingChanged));
      context.onDispose(allySize.onChange(onSettingChanged));

      // ── Per-session state ────────────────────────────────────────────────

      const bySession = new Map<string, SessionEntities>();
      const isPetType = (objectType: number): boolean => gameData.isPet(objectType);

      const stateFor = (session: SessionView): SessionEntities => {
        let state = bySession.get(session.id);
        if (state === undefined) {
          state = new SessionEntities(session, isPetType);
          bySession.set(session.id, state);
        }
        state.sync(generation);
        return state;
      };

      const policyFor = (state: SessionEntities): AntiLagPolicy =>
        state.inPetYard ? petYardPolicy : normalPolicy;

      // ── Entities ─────────────────────────────────────────────────────────

      context.packets.on('UPDATE', (packet, session) => {
        if (packet.opaque) return;
        const state = stateFor(session);

        // Done whatever the settings are: an object id is reused within a map,
        // so a stale entry would suppress whatever inherits the id next.
        const drops = packet.get('drops');
        if (Array.isArray(drops)) {
          for (const dropped of drops) {
            if (typeof dropped === 'number') state.forget(dropped);
          }
        }

        const policy = policyFor(state);
        // Walked while removals are outstanding even with every lever off: an
        // object announced again has to stop being one whose ticks are stripped.
        if (!policy.rewritesEntities && !state.hasHidden) return;

        const newObjs = packet.get('newObjs');
        if (!Array.isArray(newObjs)) return;
        const rewritten = rewriteEntries(newObjs, policy, state, session.self.objectId, true);
        // Setting the field is what marks the packet for re-encoding — even
        // when the array is the same one, because its statuses were edited in
        // place rather than rebuilt.
        if (rewritten !== undefined) packet.set('newObjs', rewritten);
      });

      context.packets.on('NEWTICK', (packet, session) => {
        if (packet.opaque) return;
        const state = stateFor(session);
        const policy = policyFor(state);
        // Statuses of removed objects have to keep being stripped even once the
        // levers are off, or the client is told about an object it never got.
        if (!policy.rewritesEntities && !state.hasHidden) return;

        const statuses = packet.get('statuses');
        if (!Array.isArray(statuses)) return;
        const rewritten = rewriteEntries(statuses, policy, state, session.self.objectId, false);
        if (rewritten !== undefined) packet.set('statuses', rewritten);
      });

      // ── Projectiles ──────────────────────────────────────────────────────

      context.packets.on('ALLYSHOOT', (packet, session) => {
        if (policyFor(stateFor(session)).dropsAllyShots) packet.drop();
      });

      // ── Effects and popups ───────────────────────────────────────────────

      const showEffectProbe = new TargetIdProbe((layout) => {
        context.log.info(`SHOWEFFECT target id layout learned: ${layout}`);
      });
      /** One probe per notification type: their payloads differ per type. */
      const notificationProbes = new Map<number, TargetIdProbe>();

      /** Whether an effect on `targetId` is one a teammate caused. */
      const causedByAlly = (
        policy: AntiLagPolicy,
        state: SessionEntities,
        targetId: number,
      ): boolean => {
        const kind = state.kindOf(policy, targetId);
        // Guildmates are deliberately absent: exempting them exempts their
        // effects too, which is the point of the exemption.
        return kind === EntityKind.Player || kind === EntityKind.Pet;
      };

      context.packets.on('SHOWEFFECT', (packet, session) => {
        const state = stateFor(session);
        const policy = policyFor(state);
        if (!policy.filtersEffects) return;

        const frame = packet.frame;
        // The type byte, and at least one byte of whatever follows it.
        if (frame.length < HEADER_BYTES + 2) return;
        const effectType = frame[HEADER_BYTES] ?? 0;

        const blocked = policy.blockedEffects;
        if (blocked !== undefined && blocks(blocked, effectType)) {
          packet.drop();
          return;
        }
        if (policy.allyEffects === AllyEffectMode.Off) return;

        const targetId = showEffectProbe.read(frame, HEADER_BYTES, state.isLive);
        if (targetId === undefined) return;

        // An effect anchored to an object we removed has nothing to attach to.
        if (state.isHidden(targetId)) {
          packet.drop();
          return;
        }
        if (!causedByAlly(policy, state, targetId)) return;
        if (policy.allyEffects === AllyEffectMode.All || blocks(ALLY_SUPPORT_EFFECTS, effectType)) {
          packet.drop();
        }
      });

      /**
       * Heal numbers, "Trapped!", buff icons — one text object per event per
       * player. In a full group these outnumber the effects themselves, and a
       * pet's heal fires on every tick it tops somebody up.
       */
      context.packets.on('NOTIFICATION', (packet, session) => {
        const state = stateFor(session);
        const policy = policyFor(state);
        if (!policy.filtersNotifications) return;

        const frame = packet.frame;
        if (frame.length < HEADER_BYTES + 2) return;
        const type = frame[HEADER_BYTES] ?? 0;

        // Bounded by construction: the type is one byte, so at most 256 probes
        // of fixed size, and in practice a handful.
        let probe = notificationProbes.get(type);
        if (probe === undefined) {
          probe = new TargetIdProbe((layout) => {
            context.log.info(
              `NOTIFICATION(type ${String(type)}) target id layout learned: ${layout}`,
            );
          });
          notificationProbes.set(type, probe);
        }

        const targetId = probe.read(frame, HEADER_BYTES, state.isLive);
        if (targetId === undefined) return;

        if (state.isHidden(targetId) || causedByAlly(policy, state, targetId)) packet.drop();
      });

      // ── Lifecycle ────────────────────────────────────────────────────────

      // `sync` notices a map change by name, which catches one that happened
      // while the plugin was switched off. This catches the case it cannot:
      // re-entering a map with the same name, where object ids are reused and a
      // carried-over removal would suppress somebody else's object.
      context.packets.on('MAPINFO', (_packet, session) => {
        bySession.get(session.id)?.reset();
      });

      context.onDispose(
        context.sessions.onDisconnected((session) => {
          bySession.delete(session.id);
        }),
      );
      context.onDispose(() => {
        bySession.clear();
        notificationProbes.clear();
      });
    },
  });
}

/**
 * Rewrites one array of statuses, in place where it can be.
 *
 * @param announcing true for `UPDATE.newObjs`, where each element is an
 *   `Entity` wrapping its status and the client is being told about the object
 *   for the first time; false for `NEWTICK.statuses`, which only reports on
 *   objects the client already holds.
 * @returns the array to store back — the original when its contents were edited
 *   in place, a shorter copy when something was removed — or `undefined` when
 *   the packet should be forwarded byte for byte.
 */
function rewriteEntries(
  entries: readonly FieldValue[],
  policy: AntiLagPolicy,
  state: SessionEntities,
  selfObjectId: number,
  announcing: boolean,
): readonly FieldValue[] | undefined {
  // Allocated only once something is actually removed. Most ticks remove
  // nothing, and copying the array to find that out is the per-tick cost this
  // feature exists to remove rather than add.
  let kept: FieldValue[] | undefined;
  let changed = false;

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry === undefined) continue;

    const status = announcing ? statusOfEntity(entry) : asStatus(entry);
    let outcome: StatusOutcome = StatusOutcome.Untouched;

    if (status !== undefined) {
      const objectId = objectIdOf(status);
      if (!announcing && state.isHidden(objectId)) {
        outcome = StatusOutcome.Removed;
      } else {
        outcome = rewriteStatus(policy, state, status, objectId, selfObjectId);
        // An object being announced again is one the client is about to hold,
        // so a removal recorded under older settings must not go on stripping
        // its ticks.
        if (announcing && outcome !== StatusOutcome.Removed && state.hasHidden) {
          state.reveal(objectId);
        }
      }
    }

    if (outcome === StatusOutcome.Removed) {
      kept ??= entries.slice(0, index);
      continue;
    }
    if (outcome === StatusOutcome.Changed) changed = true;
    kept?.push(entry);
  }

  if (kept !== undefined) return kept;
  return changed ? entries : undefined;
}
