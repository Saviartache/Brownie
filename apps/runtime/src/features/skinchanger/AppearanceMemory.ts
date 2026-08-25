/**
 * What each character class was last dressed in.
 *
 * A skin only fits the class it was made for, and a dye that suits a wizard
 * rarely suits a knight — so one shared selection meant every class switch
 * threw the previous one away. This is the per-class record that survives the
 * switch, and the run: it is carried in a hidden setting, so the plugin store
 * persists it like any other value rather than needing a second file.
 *
 * Values are the setting values themselves, as strings, because that is what a
 * select holds and what has to be handed back to it. Anything unrecognised in a
 * stored record is replaced by the default rather than refused: this is state
 * the user never typed, and a build that renamed a field must not cost them
 * every class they had configured.
 */

/** One class's selection, keyed by the settings it restores. */
export interface ClassAppearance {
  readonly skin: string;
  readonly main: string;
  readonly accessory: string;
  readonly arcaneStyle: string;
}

/** What a class looks like until something is chosen for it. */
export const DEFAULT_APPEARANCE: ClassAppearance = {
  skin: '0',
  main: '0',
  accessory: '0',
  arcaneStyle: '',
};

/** Reads the stored record. Anything malformed reads as "nothing remembered". */
export function readAppearanceMemory(raw: string): Map<number, ClassAppearance> {
  const memory = new Map<number, ClassAppearance>();
  if (raw === '') return memory;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return memory;
  }
  if (!isRecord(parsed)) return memory;

  for (const [key, entry] of Object.entries(parsed)) {
    const objectType = Number(key);
    if (!Number.isSafeInteger(objectType) || objectType < 0 || !isRecord(entry)) continue;
    memory.set(objectType, {
      skin: field(entry['skin'], DEFAULT_APPEARANCE.skin),
      main: field(entry['main'], DEFAULT_APPEARANCE.main),
      accessory: field(entry['accessory'], DEFAULT_APPEARANCE.accessory),
      arcaneStyle: field(entry['arcaneStyle'], DEFAULT_APPEARANCE.arcaneStyle),
    });
  }
  return memory;
}

export function writeAppearanceMemory(memory: ReadonlyMap<number, ClassAppearance>): string {
  return JSON.stringify(Object.fromEntries(memory));
}

function field(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
