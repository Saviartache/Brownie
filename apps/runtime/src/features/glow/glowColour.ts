/**
 * The one spelling the native module reads a colour in, and how a typed one is
 * brought to it.
 *
 * The module accepts `#rrggbbaa` and refuses everything else rather than
 * guessing at a short form — a colour read as black because a digit was missing
 * looks like a feature that worked. That strictness belongs there, at the
 * boundary; this is the other half of it, where a person types.
 *
 * So exactly two things are forgiven, because both are unambiguous: upper case,
 * and a missing alpha. Anything else is refused here too, and the caller says
 * so rather than sending a colour nobody asked for.
 */

const WITH_ALPHA = /^#[0-9a-f]{8}$/;
const WITHOUT_ALPHA = /^#[0-9a-f]{6}$/;

/**
 * @returns the colour as the module spells it, or `undefined` when the text is
 *   not one.
 */
export function normaliseGlowColour(text: string): string | undefined {
  const trimmed = text.trim().toLowerCase();
  if (WITH_ALPHA.test(trimmed)) return trimmed;
  // Opaque, which is the only alpha a glow anybody typed a colour for wants.
  if (WITHOUT_ALPHA.test(trimmed)) return `${trimmed}ff`;
  return undefined;
}
