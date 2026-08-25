import {
  PluginCategory,
  definePlugin,
  type MutablePacket,
  type Plugin,
  type SessionView,
} from '@brownie/plugin-api';
import type { FieldValue } from '@brownie/protocol';
import { StatType } from '../../constants/StatType.js';
import type { AppearanceChoice, PlayerSkin } from '../../gamedata/cosmetics.js';
import {
  StatOverrides,
  asStatus,
  statusOfEntity,
  type MutableStatus,
} from '../../state/StatOverrides.js';
import {
  DEFAULT_APPEARANCE,
  readAppearanceMemory,
  writeAppearanceMemory,
  type ClassAppearance,
} from './AppearanceMemory.js';

const DEFAULT_SKIN = DEFAULT_APPEARANCE.skin;
const DEFAULT_STYLE = DEFAULT_APPEARANCE.arcaneStyle;
const DEFAULT_OPTION = [DEFAULT_SKIN, 'Default'] as const;
const DEFAULT_STYLE_OPTION = [DEFAULT_STYLE, 'Default'] as const;
const ARCANE_STYLE_FEATURE = 'player.arcaneStyle';
const SKIN_FEATURE = 'player.skin';
const CLAIM_INTERVAL_MS = 1000;
const APPEARANCE_STATS = [StatType.Texture1, StatType.Texture2] as const;

export interface SkinChangerInputs {
  readonly skinsForClass: (objectType: number) => readonly PlayerSkin[];
  readonly mainAppearances: () => readonly AppearanceChoice[];
  readonly accessoryAppearances: () => readonly AppearanceChoice[];
  readonly arcaneStyles: () => readonly string[];
}

/** Replaces only what this client draws for its own character. */
export function createSkinChangerPlugin(inputs: SkinChangerInputs): Plugin {
  const mainOptions = appearanceOptions(inputs.mainAppearances());
  const accessoryOptions = appearanceOptions(inputs.accessoryAppearances());
  const skinOptionsByClass = new Map<number, readonly (readonly [string, string])[]>();

  return definePlugin({
    meta: {
      id: 'skin-changer',
      name: 'Skin Changer',
      category: PluginCategory.Visuals,
      description: 'Changes your character skin in this client only.',
    },

    setup(context) {
      const skin = context.settings.select<string>('skin', {
        label: 'Skin',
        default: DEFAULT_SKIN,
        dynamic: true,
        options: [DEFAULT_OPTION],
      });
      const mainAppearance = context.settings.select<string>('mainAppearance', {
        group: 'Dyes and effects',
        label: 'Main color / effect',
        default: DEFAULT_APPEARANCE.main,
        options: mainOptions,
      });
      const accessoryAppearance = context.settings.select<string>('accessoryAppearance', {
        group: 'Dyes and effects',
        label: 'Accessory color / effect',
        default: DEFAULT_APPEARANCE.accessory,
        options: accessoryOptions,
      });
      const arcaneStyle = context.settings.select<string>('arcaneStyle', {
        group: 'Arcane Style',
        label: 'Arcane Style',
        default: DEFAULT_STYLE,
        options: [
          DEFAULT_STYLE_OPTION,
          ...inputs.arcaneStyles().map((name): readonly [string, string] => [name, name]),
        ],
      });
      const memory = context.settings.text('perClass', {
        label: 'Selection remembered per class',
        default: '',
        hidden: true,
      });
      const remembered = readAppearanceMemory(memory.get());
      const states = new Map<string, StatOverrides>();
      const targets = new Map<number, number>();
      let displayedClass = -1;

      const claimSelection = (
        feature: string,
        current: () => string,
        onChange: (listener: () => void) => () => void,
        defaultValue: string,
      ): void => {
        let claimed = false;
        const claim = (): void => {
          const value = current();
          if (value === defaultValue) {
            if (claimed) context.native.setFeature(feature, '');
            claimed = false;
            return;
          }
          context.native.setFeature(feature, value);
          claimed = true;
        };
        context.onDispose(
          onChange(() => {
            if (context.enabled) claim();
          }),
        );
        context.timers.setInterval(claim, CLAIM_INTERVAL_MS);
        context.onDispose(() => {
          if (claimed) context.native.setFeature(feature, '');
        });
      };

      const refreshTargets = (): void => {
        targets.clear();
        addTarget(targets, StatType.Texture1, mainAppearance.get());
        addTarget(targets, StatType.Texture2, accessoryAppearance.get());
      };
      refreshTargets();
      for (const setting of [mainAppearance, accessoryAppearance]) {
        context.onDispose(setting.onChange(refreshTargets));
      }

      claimSelection(
        SKIN_FEATURE,
        () => skin.get(),
        (listener) => skin.onChange(listener),
        DEFAULT_SKIN,
      );
      claimSelection(
        ARCANE_STYLE_FEATURE,
        () => arcaneStyle.get(),
        (listener) => arcaneStyle.onChange(listener),
        DEFAULT_STYLE,
      );

      const remember = (): void => {
        if (displayedClass < 0) return;
        remembered.set(displayedClass, {
          skin: skin.get(),
          main: mainAppearance.get(),
          accessory: accessoryAppearance.get(),
          arcaneStyle: arcaneStyle.get(),
        });
        memory.set(writeAppearanceMemory(remembered));
      };
      for (const setting of [skin, mainAppearance, accessoryAppearance, arcaneStyle]) {
        context.onDispose(setting.onChange(remember));
      }

      const restore = (appearance: ClassAppearance): void => {
        // Skin first: its options were just replaced, and a value the new class
        // cannot wear is refused, leaving the default `setOptions` fell back to.
        skin.set(appearance.skin);
        mainAppearance.set(appearance.main);
        accessoryAppearance.set(appearance.accessory);
        arcaneStyle.set(appearance.arcaneStyle);
      };

      const showClass = (objectType: number): void => {
        if (objectType < 0 || objectType === displayedClass) return;
        // Read before anything below runs: every write from here on is recorded
        // against the class being switched to, which overwrites this entry.
        const wanted = remembered.get(objectType);
        displayedClass = objectType;

        let options = skinOptionsByClass.get(objectType);
        if (options === undefined) {
          options = [
            DEFAULT_OPTION,
            ...inputs
              .skinsForClass(objectType)
              .map((definition): readonly [string, string] => [
                String(definition.type),
                definition.name,
              ]),
          ];
          skinOptionsByClass.set(objectType, options);
        }
        skin.setOptions(options);

        // A class played for the first time keeps what is on screen as its
        // starting point — which is also how a selection made before this build
        // knew about classes carries over instead of being reset to Default.
        if (wanted === undefined) {
          remember();
          return;
        }
        restore(wanted);
      };

      const rewrite = (
        packet: MutablePacket,
        field: 'newObjs' | 'statuses',
        session: SessionView,
        announced: boolean,
      ): void => {
        showClass(session.self.objectType);
        if (packet.opaque || session.self.objectId < 0) return;

        let state = states.get(session.id);
        if (state === undefined) {
          state = new StatOverrides();
          states.set(session.id, state);
        }

        const entries = packet.get(field);
        if (!Array.isArray(entries)) return;
        const status = findSelfStatus(entries, session.self.objectId, announced);
        if (status === undefined) return;
        state.remember(status, APPEARANCE_STATS);
        if (targets.size === 0 && !state.active) return;
        if (!state.applyTo(status, targets, announced)) return;
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
          states.delete(session.id);
        }),
      );
      context.onDispose(() => {
        states.clear();
      });
    },
  });
}

function appearanceOptions(
  appearances: readonly AppearanceChoice[],
): readonly (readonly [string, string])[] {
  return [
    DEFAULT_OPTION,
    ...appearances.map((appearance): readonly [string, string] => [
      String(appearance.value),
      `${appearance.kind === 'color' ? 'Color' : 'Effect'}: ${appearance.name}`,
    ]),
  ];
}

function addTarget(targets: Map<number, number>, stat: number, raw: string): void {
  const value = Number(raw);
  if (Number.isSafeInteger(value) && value !== 0) targets.set(stat, value);
}

function findSelfStatus(
  entries: readonly FieldValue[],
  objectId: number,
  announced: boolean,
): MutableStatus | undefined {
  for (const entry of entries) {
    const status = announced ? statusOfEntity(entry) : asStatus(entry);
    if (status?.objectId === objectId) return status;
  }
  return undefined;
}
