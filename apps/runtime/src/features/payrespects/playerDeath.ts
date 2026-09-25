/**
 * Who a `NOTIFICATION` says has just died, when that is what it says.
 *
 * **The definition file stops after two bytes, and this reads one body behind
 * them by hand.** `NOTIFICATION` is a tagged union: its first byte names the
 * kind, and what follows the second depends on the kind — a message and a
 * picture for one, an object id and an emote for another, a queue position for
 * a third. The schema has no way to say "these fields when the first byte is
 * 7", so it names the two bytes every kind shares and keeps the rest as
 * trailing bytes. A player's death is one kind whose body is known exactly,
 * read out of the client's own handler — `docs/protocol.md` has the layout and
 * the evidence — and it is read here over the bounds-checked reader the codec
 * itself uses.
 *
 * **The message is not a sentence, and it is not JSON either.** It is the
 * game's localisation envelope, `{"k":…,"t":{"player":…,"enemy":…,}}`, which
 * the client turns into words in whatever language it runs in — and the server
 * writes it as a template, with a comma after the last token, which
 * `JSON.parse` refuses outright. The first version of this parsed it, and so
 * read nobody's death at all. The one token needed is matched instead.
 */

import { ByteReader, DecodeError, HEADER_BYTES } from '@brownie/protocol';
import { bareName } from '../../state/playerName.js';

/** The notification kind the client shows a player's death as. */
export const PLAYER_DEATH_KIND = 7;

/** The kind byte and the flags byte every notification opens with. */
const PREAMBLE_BYTES = 2;

/**
 * The `player` token, wherever it sits in the envelope.
 *
 * A player's name is letters, so a value holding a quote or a backslash is not
 * one, and the match fails rather than guessing where such a value ends.
 */
const PLAYER_TOKEN = /"player"\s*:\s*"([^"\\]*)"/;

/**
 * The name of the player a death notification is about.
 *
 * @param frame The packet as it arrived, header included.
 * @returns the bare name, or `undefined` for any other kind of notification and
 *   for a death notification this cannot read — a body too short for what it
 *   claims, or a message with no `player` token in it.
 */
export function deadPlayerName(frame: Buffer): string | undefined {
  // Checked before anything is built: a fight sends notifications several
  // times a second — every heal number is one — and almost none is a death.
  if (frame[HEADER_BYTES] !== PLAYER_DEATH_KIND) return undefined;

  let message: string;
  try {
    // The picture after the message — the dead character's class, drawn in
    // the popup — is not read: nothing here needs it, and demanding it would
    // only make a longer body from a later build fail to parse.
    message = new ByteReader(frame, HEADER_BYTES + PREAMBLE_BYTES).string16();
  } catch (cause) {
    // A body too short for what it claims is malformed input, which fails
    // safe here like everywhere else: it names nobody.
    if (cause instanceof DecodeError) return undefined;
    throw cause;
  }
  return playerToken(message);
}

/** The `player` token of an envelope, as a bare name. */
function playerToken(message: string): string | undefined {
  const token = PLAYER_TOKEN.exec(message)?.[1];
  if (token === undefined) return undefined;
  const name = bareName(token);
  return name === '' ? undefined : name;
}
