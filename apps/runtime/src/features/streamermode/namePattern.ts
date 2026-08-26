/**
 * Finding the player's own name inside a line of chat.
 *
 * A name is replaced only where it stands as a word of its own. Two players in
 * one realm routinely have names that contain each other's — `Sammy` inside
 * `SammySosa` — and a plain substring replacement would rewrite somebody else's
 * name into the alias, which is a different person's message made unreadable.
 *
 * The name arrives from the game server, so it is escaped before it becomes
 * pattern syntax rather than trusted to be the plain word it usually is.
 */

/** What would otherwise be read as pattern syntax rather than as a name. */
const SYNTAX = /[.*+?^${}()|[\]\\]/g;

/** Letters and digits, either side of which a name stands on its own. */
const WORD = '[\\p{L}\\p{N}]';

/**
 * The player's name as a pattern, or `undefined` when there is no name to hide.
 *
 * Empty until the server has said what the character is called, which it does
 * with the object itself — a handler running before that has nothing to do
 * rather than a pattern that matches everywhere.
 */
export function namePattern(name: string): RegExp | undefined {
  const wanted = name.trim();
  if (wanted === '') return undefined;
  const literal = wanted.replace(SYNTAX, '\\$&');
  return new RegExp(`(?<!${WORD})${literal}(?!${WORD})`, 'giu');
}
