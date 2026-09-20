/**
 * What each character class was last dressed in.
 *
 * A skin only fits the class it was made for, and a dye that suits a wizard
 * rarely suits a knight — so one shared selection meant every class switch
 * threw the previous one away. This is the per-class record that survives the
 * switch, and the run: it is carried in a hidden setting, so the plugin store
 * persists it like any other value rather than needing a second file.
 *
 * Values are the setting values themselves — strings for the choosers, a number
 * for the size slider — because that is what a setting holds and what has to be
 * handed back to it. Anything unrecognised in a stored record is replaced by the
 * default rather than refused: this is state the user never typed, and a build
 * that renamed a field must not cost them every class they had configured.
 */

/** The size the client assumes for an object whose status carries no stat 2. */
export const DEFAULT_SIZE = 100;
export const MIN_SIZE_PERCENT = 0;
export const MAX_SIZE_PERCENT = 200;

/** One class's selection, keyed by the settings it restores. */
export interface ClassAppearance {
  readonly skin: string;
  readonly main: string;
  readonly accessory: string;
  readonly arcaneStyle: string;
  /** Stat 2, as a percentage: 100 is the size the class is drawn at normally. */
  readonly size: number;
}

/** What a class looks like until something is chosen for it. */
export const DEFAULT_APPEARANCE: ClassAppearance = {
  skin: '0',
  main: '0',
  accessory: '0',
  arcaneStyle: '',
  size: DEFAULT_SIZE,
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
      size: size(entry['size']),
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

/** Clamped on the way in: a stored size is only ever what the slider allows. */
function size(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_APPEARANCE.size;
  return Math.min(MAX_SIZE_PERCENT, Math.max(MIN_SIZE_PERCENT, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
