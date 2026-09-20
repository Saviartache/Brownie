/**
 * Reading a player's name out of the name stat.
 *
 * **The stat is not only the name.** For some characters the server spells it
 * as the name, a comma and a short token — `Ally,9a16` — and that tail is no
 * part of what anybody calls the player. A line that repeats it reads as a bug,
 * and a comparison against it fails against the name the same player is spelled
 * with everywhere else.
 *
 * Next to `stats.ts` rather than inside a feature because four of them ask the
 * question and none of them owns the answer: it is a fact about how this game
 * writes a name.
 */

/**
 * The name itself — everything up to the first comma, trimmed.
 *
 * Empty for a name that is only a tail, and for an entity the server has not
 * named at all, so a caller can tell "no name" from a name and pick its own
 * word for it. That is left to the caller on purpose: what a nameless character
 * is called depends on what is being said about them.
 *
 * **Not applied in `EntityRecord`, which keeps the stat as the server spelled
 * it**, for two reasons. Auto-teleport puts that exact string in
 * `TELEPORT.playerName`, where the server is the one matching it against the
 * character, and a trimmed copy there would be a teleport that quietly stops
 * working. And a comma inside a name is ordinary for everything that is not a
 * player — `Craig, Intern of the Mad God` is an object id in `objects.xml` — so
 * the same rule applied to an enemy would cut a real name in half. This is a
 * rule about *player* names, asked for by name where one is read as one.
 */
export function bareName(name: string): string {
  return name.split(',', 1)[0]?.trim() ?? '';
}
