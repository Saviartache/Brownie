/**
 * The four ready-made mixes, and nothing about how they are applied.
 *
 * Each preset is a **full** assignment of the knobs it owns, so switching
 * between them can never leave a leftover from the previous one behind.
 * `blockedEffectTypes` is deliberately not among them: it is a list the user
 * edits, and a preset that silently rewrote it would lose their work.
 */

import { AllyEffectMode, PetMode, PlayerMode } from './policy.js';

export interface AntiLagPresetValues {
  readonly hideAllies: PlayerMode;
  readonly hideAllyProjectiles: boolean;
  readonly petHide: PetMode;
  readonly allyEffects: AllyEffectMode;
  readonly hideAllyNotifications: boolean;
  readonly blockShowEffect: boolean;
  readonly sizeScaling: boolean;
  readonly playerSize: number;
  readonly allySize: number;
}

export const PresetId = {
  Off: 'off',
  Effects: 'effects',
  Crowded: 'crowded',
  Max: 'max',
} as const;

export type PresetId = (typeof PresetId)[keyof typeof PresetId];

/** `custom` is the user's own mix — choosing it applies nothing. */
export type PresetChoice = PresetId | 'custom';

export const PRESETS: Readonly<Record<PresetId, AntiLagPresetValues>> = {
  off: {
    hideAllies: PlayerMode.Off,
    hideAllyProjectiles: false,
    petHide: PetMode.Off,
    allyEffects: AllyEffectMode.Off,
    hideAllyNotifications: false,
    blockShowEffect: false,
    sizeScaling: false,
    playerSize: 100,
    allySize: 100,
  },
  effects: {
    hideAllies: PlayerMode.Off,
    hideAllyProjectiles: false,
    petHide: PetMode.Off,
    allyEffects: AllyEffectMode.Support,
    hideAllyNotifications: true,
    blockShowEffect: true,
    sizeScaling: false,
    playerSize: 100,
    allySize: 100,
  },
  crowded: {
    hideAllies: PlayerMode.Off,
    hideAllyProjectiles: true,
    petHide: PetMode.All,
    allyEffects: AllyEffectMode.All,
    hideAllyNotifications: true,
    blockShowEffect: true,
    sizeScaling: true,
    playerSize: 100,
    allySize: 50,
  },
  max: {
    hideAllies: PlayerMode.Remove,
    hideAllyProjectiles: true,
    petHide: PetMode.Remove,
    allyEffects: AllyEffectMode.All,
    hideAllyNotifications: true,
    blockShowEffect: true,
    sizeScaling: false,
    playerSize: 100,
    allySize: 100,
  },
};

const PRESET_KEYS = Object.keys(PRESETS.off) as readonly (keyof AntiLagPresetValues)[];

/** Whether the current mix is still the one the preset label claims it is. */
export function presetMatches(current: AntiLagPresetValues, preset: AntiLagPresetValues): boolean {
  return PRESET_KEYS.every((key) => current[key] === preset[key]);
}
