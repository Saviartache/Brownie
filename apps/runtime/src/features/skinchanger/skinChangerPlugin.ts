import {
  PluginCategory,
  definePlugin,
  type AssetOption as AssetOptionOf,
  type MutablePacket,
  type Plugin,
  type SessionView,
} from '@brownie/plugin-api';
import { StatType } from '../../constants/StatType.js';
import {
  appearancePicture,
  type AppearanceChoice,
  type PlayerSkin,
} from '../../gamedata/cosmetics.js';
import { StatOverrides, findStatus } from '../../state/StatOverrides.js';
import {
  DEFAULT_APPEARANCE,
  DEFAULT_SIZE,
  MAX_SIZE_PERCENT,
  MIN_SIZE_PERCENT,
  readAppearanceMemory,
  writeAppearanceMemory,
  type ClassAppearance,
} from './AppearanceMemory.js';

const DEFAULT_SKIN = DEFAULT_APPEARANCE.skin;
const DEFAULT_STYLE = DEFAULT_APPEARANCE.arcaneStyle;
/** Every chooser here holds a plain string, so its options are these. */
type AssetOption = AssetOptionOf<string>;

const DEFAULT_OPTION = [DEFAULT_SKIN, 'Default'] as const;
const DEFAULT_STYLE_OPTION = [DEFAULT_STYLE, 'Default'] as const;
const ARCANE_STYLE_FEATURE = 'player.arcaneStyle';
const SKIN_FEATURE = 'player.skin';
const CLAIM_INTERVAL_MS = 1000;
const APPEARANCE_STATS = [StatType.Texture1, StatType.Texture2, StatType.Size] as const;
/**
 * What stat 2 reads as when no status carries it, so that turning the slider
 * back to 100 restores an ordinary character rather than an invisible one.
 */
const ABSENT_STATS: ReadonlyMap<number, number> = new Map([[StatType.Size, DEFAULT_SIZE]]);

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
  const skinOptionsByClass = new Map<number, readonly AssetOption[]>();

  return definePlugin({
    meta: {
      id: 'skin-changer',
      name: 'Skin Changer',
      category: PluginCategory.Visuals,
      description: 'Changes your character skin in this client only.',
    },

    setup(context) {
      // Skins, dyes and cloths are all pictures: a name like "Sacred Cloak
      // Priest" or "Large Beisa Cloth" says nothing a player can picture, and
      // there are hundreds of each. So all three are grids — the same widget
      // the item and portal choosers use — and the overlay falls back to the
      // drop-down where there is no game data to draw from.
      const skin = context.settings.assetSelect<string>('skin', {
        label: 'Skin',
        default: DEFAULT_SKIN,
        dynamic: true,
        options: [DEFAULT_OPTION],
      });
      const mainAppearance = context.settings.assetSelect<string>('mainAppearance', {
        group: 'Dyes and effects',
        label: 'Main color / effect',
        default: DEFAULT_APPEARANCE.main,
        options: mainOptions,
      });
      const accessoryAppearance = context.settings.assetSelect<string>('accessoryAppearance', {
        group: 'Dyes and effects',
        label: 'Accessory color / effect',
        default: DEFAULT_APPEARANCE.accessory,
        options: accessoryOptions,
      });
      // Your own size, which used to live in anti-lag as a percentage of what
      // the server sent. Here it is the size itself: this is the plugin that
      // already owns what your character looks like, and it is remembered per
      // class with the rest of it — a giant knight and a tiny archer are two
      // different wishes, not one.
      const size = context.settings.range('size', {
        group: 'Size',
        label: 'Your size (%, 100 is normal, 0 hides you)',
        default: DEFAULT_SIZE,
        min: MIN_SIZE_PERCENT,
        max: MAX_SIZE_PERCENT,
        step: 5,
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
        // 100 is "leave it alone": a skin the game draws larger than life keeps
        // its own size until the slider actually asks for something else.
        const wantedSize = size.get();
        if (wantedSize !== DEFAULT_SIZE) targets.set(StatType.Size, wantedSize);
      };
      refreshTargets();
      for (const setting of [mainAppearance, accessoryAppearance, size]) {
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
          size: size.get(),
        });
        memory.set(writeAppearanceMemory(remembered));
      };
      for (const setting of [skin, mainAppearance, accessoryAppearance, arcaneStyle, size]) {
        context.onDispose(setting.onChange(remember));
      }

      const restore = (appearance: ClassAppearance): void => {
        // Skin first: its options were just replaced, and a value the new class
        // cannot wear is refused, leaving the default `setOptions` fell back to.
        skin.set(appearance.skin);
        mainAppearance.set(appearance.main);
        accessoryAppearance.set(appearance.accessory);
        arcaneStyle.set(appearance.arcaneStyle);
        size.set(appearance.size);
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
            // "Default" is the class in its own clothes, so the class itself is
            // the picture — the one tile in the grid that has no skin to show.
            [DEFAULT_SKIN, 'Default', String(objectType)],
            // A skin's value is its object type, which is also the key its
            // picture is filed under, so the option needs no third field.
            ...inputs
              .skinsForClass(objectType)
              .map((definition): AssetOption => [String(definition.type), definition.name]),
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
          state = new StatOverrides(ABSENT_STATS);
          states.set(session.id, state);
        }

        const entries = packet.get(field);
        if (!Array.isArray(entries)) return;
        const status = findStatus(entries, session.self.objectId, announced);
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

/**
 * The dye and effect choices, as pictures.
 *
 * A dye's own icon is the same little bottle for all four hundred of them, so
 * the picture is what the dye *does*: the colour it paints, or the cloth it
 * weaves — see `appearancePicture`. The label keeps its "Color:" / "Effect:"
 * prefix, which is what the grid's search box filters on.
 */
function appearanceOptions(appearances: readonly AppearanceChoice[]): readonly AssetOption[] {
  return [
    DEFAULT_OPTION,
    ...appearances.map((appearance): AssetOption => [
      String(appearance.value),
      `${appearance.kind === 'color' ? 'Color' : 'Effect'}: ${appearance.name}`,
      appearancePicture(appearance.value),
    ]),
  ];
}

function addTarget(targets: Map<number, number>, stat: number, raw: string): void {
  const value = Number(raw);
  if (Number.isSafeInteger(value) && value !== 0) targets.set(stat, value);
}
