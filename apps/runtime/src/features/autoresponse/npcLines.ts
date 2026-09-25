/**
 * Recognising, in a line an NPC said, the question the catalogue has an answer
 * for.
 *
 * **An NPC speaks through the same `TEXT` packet players chat through**, and the
 * server tells the two apart with a negative star count, which no player has.
 * The rest of the runtime reads it the same way: the chat filter never examines
 * a line with negative stars, and the Sanctuary plugin knows its chancellor as
 * `#Chancellor Dammah` — the `#` in front being the other mark the server puts
 * on a speaker that is not a player.
 *
 * **Everything is compared folded.** The lines in the catalogue were copied from
 * the wiki rather than captured off the wire, so they are only as exact as
 * whoever transcribed them: a capital, an exclamation mark, a curly quote, a
 * question mark the game puts on a name. Case, accents, punctuation and runs of
 * spacing are dropped on both sides, and what is left has to match as *whole
 * words* — so `ready` is found in `Say ready!` and not in `already`, and `Umi`
 * names `Village Girl Umi?` and not `Umiko`.
 *
 * **A line that ends a question is looked for before the question.** The
 * Beekeeper's computer asks for a `Password` and answers the right one with
 * `Password Correct`; read the other way round, the answer would be taken for
 * the question being asked again.
 */

import type { ChatEvent, ChatPrompt } from './chatEvents.js';

/**
 * How much of a line is read.
 *
 * The server chooses the length. What an NPC asks is one sentence, and nothing
 * worth answering is hidden past the first few hundred characters of one.
 */
const MAX_READ_CHARS = 512;

/** Anything that is not a letter or a digit, in any script. */
const NOT_A_WORD = /[^\p{L}\p{N}]+/gu;

/** The accents NFKD splits off the letters they sat on. */
const COMBINING_MARKS = /\p{M}+/gu;

/**
 * A line reduced to its words: lower case, unaccented, one space between words
 * and one either side.
 *
 * The padding is what makes a phrase match whole words through a plain
 * `includes`: ` ready ` is in ` say ready ` and not in ` already `. A line with
 * no word in it folds to the empty string, unpadded, which holds nothing and is
 * held by nothing.
 */
export function foldLine(text: string): string {
  const words = text
    .slice(0, MAX_READ_CHARS)
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(NOT_A_WORD, ' ')
    .trim();
  return words === '' ? '' : ` ${words} `;
}

/** Whether a folded line holds a folded phrase, as whole words. */
function holds(line: string, phrase: string): boolean {
  return phrase !== '' && line.includes(phrase);
}

/** A prompt with its lines and its answer folded, as they are compared. */
export interface FoldedPrompt {
  readonly source: ChatPrompt;
  readonly lines: readonly string[];
  readonly answer: string;
}

/** An event folded once, when the plugin is built, rather than per line heard. */
export interface FoldedEvent {
  readonly source: ChatEvent;
  readonly speaker: string;
  readonly prompts: readonly FoldedPrompt[];
  readonly settledBy: readonly string[];
}

/**
 * Folds the catalogue.
 *
 * @throws {Error} for an entry that folds to nothing — a speaker, a line or an
 *   answer with no word in it would match everything or nothing, and either is
 *   a mistake in the catalogue rather than something to carry into a session —
 *   and for a prompt with no line to recognise it by.
 */
export function foldEvents(events: readonly ChatEvent[]): readonly FoldedEvent[] {
  return events.map((event) => ({
    source: event,
    speaker: foldRequired(event.speaker, `${event.id}: speaker`),
    prompts: event.prompts.map((prompt) => {
      if (prompt.lines.length === 0) {
        throw new Error(`${event.id}: the prompt answered "${prompt.answer}" has no line`);
      }
      return {
        source: prompt,
        lines: prompt.lines.map((line) => foldRequired(line, `${event.id}: prompt`)),
        answer: foldRequired(prompt.answer, `${event.id}: answer`),
      };
    }),
    settledBy: event.settledBy.map((line) => foldRequired(line, `${event.id}: settling line`)),
  }));
}

function foldRequired(text: string, what: string): string {
  const folded = foldLine(text);
  if (folded === '') throw new Error(`${what} "${text}" has no word in it`);
  return folded;
}

/** What an NPC's line turned out to be. */
export type HeardLine =
  /** A line that ends the question, answered or not. */
  | { readonly kind: 'settled'; readonly event: ChatEvent }
  /** One of the catalogue's questions, from the NPC that asks it. */
  | { readonly kind: 'prompt'; readonly event: ChatEvent; readonly prompt: FoldedPrompt }
  /** Anything else that NPC said — worth a log line, since wording drifts. */
  | { readonly kind: 'other'; readonly event: ChatEvent };

/**
 * What an NPC's line is, as far as the catalogue is concerned.
 *
 * @param events The folded catalogue.
 * @param speaker The name the line came under, as the server sent it — the
 *   leading `#` included or not, since folding drops it either way.
 * @param line What was said.
 * @returns `undefined` for a speaker no event names, which is nearly every
 *   line: an NPC the catalogue has nothing to say to.
 */
export function hearNpcLine(
  events: readonly FoldedEvent[],
  speaker: string,
  line: string,
): HeardLine | undefined {
  const foldedSpeaker = foldLine(speaker);
  let first: ChatEvent | undefined;
  let foldedLine: string | undefined;

  for (const event of events) {
    if (!holds(foldedSpeaker, event.speaker)) continue;
    first ??= event.source;
    // Folded once, and only for a speaker some event names: the NPCs the
    // catalogue cares about are a handful of the ones that talk.
    foldedLine ??= foldLine(line);
    const said = foldedLine;

    if (event.settledBy.some((settling) => holds(said, settling))) {
      return { kind: 'settled', event: event.source };
    }
    const prompt = event.prompts.find((candidate) =>
      candidate.lines.some((asked) => holds(said, asked)),
    );
    if (prompt !== undefined) return { kind: 'prompt', event: event.source, prompt };
  }
  return first === undefined ? undefined : { kind: 'other', event: first };
}
