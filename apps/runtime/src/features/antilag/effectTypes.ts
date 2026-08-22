/**
 * `SHOWEFFECT`'s first body byte, and which values of it are worth dropping.
 *
 * The table is the client's own enum order, carried over from the reference
 * implementation. It is only ever used to turn a name a user typed into the
 * number on the wire — nothing in the packet path looks a name up.
 *
 * Both sets are 256-entry flag tables rather than `Set<number>`: the byte is
 * already the index, so a lookup is one bounds-checked load with no hashing and
 * no allocation, and building one costs a single 256-byte buffer per settings
 * change.
 */

const EFFECT_TYPE_NAMES: readonly string[] = [
  'Unknown',
  'Heal',
  'Teleport',
  'Stream',
  'Throw',
  'Nova',
  'Poison',
  'Line',
  'Burst',
  'Flow',
  'Ring',
  'Lightning',
  'Collapse',
  'Coneblast',
  'Jitter',
  'Flash',
  'ThrowProjectile',
  'Shocker',
  'Shockee',
  'RisingFury',
  'NovaNoAoe',
  'InspiredEffect',
  'HolyBeamEffect',
  'CircleTelegraphEffect',
  'ChaosBeamEffect',
  'TeleportMonsterEffect',
  'MeteorEffect',
  'GildedBuff',
  'JadeBuff',
  'ChaosBuff',
  'ThunderBuff',
  'StatusFlash',
  'FireOrbBuff',
];

const EFFECT_COUNT = 256;

/** The beam, stream and nova families — what floods a screen in a group. */
export const DEFAULT_BLOCKED_EFFECTS = 'Stream, Line, Burst, Flow, Ring, Coneblast';

/**
 * Support visuals teammates cast constantly: heal pulses, class auras and buff
 * flashes. Every one of them is drawn per affected player per cast, which is
 * why a twenty-man group turns a boss room into a slideshow.
 */
export const ALLY_SUPPORT_EFFECTS = maskOf([
  'Heal',
  'Nova',
  'NovaNoAoe',
  'Ring',
  'RisingFury',
  'InspiredEffect',
  'HolyBeamEffect',
  'GildedBuff',
  'JadeBuff',
  'ChaosBuff',
  'ThunderBuff',
  'StatusFlash',
  'FireOrbBuff',
]);

/**
 * Parses the user's list of effect types: names or `0`–`255`, comma separated.
 *
 * @returns a flag table, or `undefined` when the list names nothing — which is
 *   the difference between "block these" and "block nothing", and lets the
 *   caller skip the packet entirely rather than testing an empty table.
 */
export function parseEffectTypes(raw: string): Uint8Array | undefined {
  const mask = new Uint8Array(EFFECT_COUNT);
  let found = false;

  for (const part of raw.split(/[,;]+/)) {
    const text = part.trim();
    if (text === '') continue;

    if (/^\d+$/.test(text)) {
      const id = Number(text);
      if (id >= 0 && id < EFFECT_COUNT) {
        mask[id] = 1;
        found = true;
      }
      continue;
    }

    const index = EFFECT_TYPE_NAMES.findIndex((name) => name.toLowerCase() === text.toLowerCase());
    if (index >= 0) {
      mask[index] = 1;
      found = true;
    }
  }

  return found ? mask : undefined;
}

export function blocks(mask: Uint8Array, effectType: number): boolean {
  return mask[effectType] === 1;
}

function maskOf(names: readonly string[]): Uint8Array {
  const mask = new Uint8Array(EFFECT_COUNT);
  for (const name of names) {
    const index = EFFECT_TYPE_NAMES.indexOf(name);
    if (index >= 0) mask[index] = 1;
  }
  return mask;
}
