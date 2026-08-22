/**
 * Which stats a glow mode writes, and what it writes to them.
 *
 * Two independent stats decide the glow the client draws around a character:
 * the glow stat, whose value reads as a colour, and the supporter stat, a tier
 * index the client maps to a colour of its own. A preset drives one of them;
 * Custom drives both by hand, which is how a colour with no preset yet is found
 * — stepping the supporter tier through 1, 2, 3 … reaches the ones this file
 * does not name.
 *
 * Neither id is named in `stat-types.json`: 59 was recovered by hand, and 99 is
 * listed there as `FortuneTokens` while `Supporter` sits at 102. The defaults
 * are what the running client was observed to read, and both are settings so a
 * game patch that moves them needs no code change.
 *
 * Resolved once per settings change and never per packet: `NEWTICK` carries a
 * status every tick, and rebuilding this table inside that handler would answer
 * a question whose answer only moves when somebody changes a setting.
 */

/** How the glow is chosen. Values are persisted in config — don't rename. */
export const GlowMode = {
  Off: 'off',
  /** The glow stat, which reads as red. */
  Red: 'red',
  /** The first supporter tier, which reads as purple. */
  Purple: 'purple',
  /** Both stats, by hand. */
  Custom: 'custom',
} as const;

export type GlowMode = (typeof GlowMode)[keyof typeof GlowMode];

/** Not named in `stat-types.json`; recovered by hand. 100 reads as red. */
export const DEFAULT_GLOW_STAT = 59;
/** The supporter tier stat. Non-zero values pick a tier colour. */
export const DEFAULT_SUPPORTER_STAT = 99;

const RED_GLOW_VALUE = 100;
const PURPLE_SUPPORTER_VALUE = 1;

/** In Custom, a stat value of -1 means "leave this stat as the server sent it". */
export const LEAVE_ALONE = -1;

export interface GlowSettings {
  readonly mode: GlowMode;
  readonly glowStatId: number;
  readonly supporterStatId: number;
  readonly customGlow: number;
  readonly customSupporter: number;
}

/** Shared, so "nothing to do" costs no allocation. */
const NO_TARGETS: ReadonlyMap<number, number> = new Map();

/**
 * @returns stat id → the value the client should see. Empty means the stream
 *   passes through untouched.
 */
export function resolveGlowTargets(settings: GlowSettings): ReadonlyMap<number, number> {
  const glowId = statId(settings.glowStatId);
  const supporterId = statId(settings.supporterStatId);

  switch (settings.mode) {
    case GlowMode.Red:
      return glowId === undefined ? NO_TARGETS : new Map([[glowId, RED_GLOW_VALUE]]);
    case GlowMode.Purple:
      return supporterId === undefined
        ? NO_TARGETS
        : new Map([[supporterId, PURPLE_SUPPORTER_VALUE]]);
    case GlowMode.Custom: {
      const targets = new Map<number, number>();
      if (glowId !== undefined && settings.customGlow !== LEAVE_ALONE) {
        targets.set(glowId, Math.trunc(settings.customGlow));
      }
      if (supporterId !== undefined && settings.customSupporter !== LEAVE_ALONE) {
        targets.set(supporterId, Math.trunc(settings.customSupporter));
      }
      return targets.size === 0 ? NO_TARGETS : targets;
    }
    default:
      return NO_TARGETS;
  }
}

/**
 * A stat id, or `undefined` for one no status could carry.
 *
 * The ids are settings, so they arrive from the overlay and from config written
 * by an older build. A fractional or negative id would match nothing and inject
 * a stat the encoder cannot write.
 */
function statId(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const id = Math.trunc(value);
  return id < 0 ? undefined : id;
}
