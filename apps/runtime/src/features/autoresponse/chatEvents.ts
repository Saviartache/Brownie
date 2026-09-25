/**
 * The occasions on which the game waits for a player to say something in chat,
 * and what to say.
 *
 * **Where this comes from.** The RealmEye wiki, as of Exalt 7.0.0.0 (Sep 2026):
 * the dungeon, boss and dialogue pages, read for every place an NPC waits on a
 * chat line. Nothing here was captured off the wire, so every entry is written
 * to survive the wiki being slightly off — see `npcLines.ts` for how a line is
 * compared — and anything else an NPC named here says is logged, which is what
 * shows a question whose wording has drifted.
 *
 * **How the game reads an answer**, which is why the answers are plain: case and
 * punctuation are ignored and the spelling has to be exact (the Beekeeper page
 * says so in as many words), and — but for Umi's challenge — anybody in the
 * dungeon can give it.
 *
 * **What is on until switched off, and what is not.** A question with a right
 * answer, and a prompt that only moves an event along — `ready`, `skip` — are
 * answered by default. Anything that changes what the player is in for starts
 * switched off: the Kitsune Umi fight, Challenge Mode, and the fishing game,
 * which scores worse for starting before the rods are on.
 *
 * **What is deliberately not here**, so nobody adds it back by accident:
 *
 * - Umi's "first time at the festival?" — `yes` switches the whole group to
 *   Leisurely Mode: worse loot, no Kitsune Umi.
 * - The Realm Eye in the Cursed Library, and the Lair of Draconis colours —
 *   choices, not answers.
 * - Trick-or-treat — it takes a costume, and it is the player who speaks
 *   first, not the NPC.
 * - The Master Rat's riddles — gone since Exalt 1.3.0.0 (Dec 2020); he fights
 *   now, and none of the legacy dungeons brings them back.
 */

/** One thing an NPC asks, and the answer it takes. */
export interface ChatPrompt {
  /**
   * What the NPC says when it asks — any one of these, as a phrase its line
   * holds rather than the whole of it. Compared folded (`npcLines.ts`): case,
   * accents and punctuation do not count, whole words do.
   */
  readonly lines: readonly string[];
  /** What is said back, exactly as it goes into the chat box. */
  readonly answer: string;
}

/** One occasion on which an NPC waits to be answered in chat. */
export interface ChatEvent {
  /**
   * Stable, and the key its switch is stored under: renaming one loses the
   * player's choice.
   */
  readonly id: string;
  /** What the overlay calls it: who asks, what is said, and where. */
  readonly label: string;
  /**
   * Who asks: whole words of the name the NPC speaks under. Compared folded,
   * like the lines — so `Umi` is `Village Girl Umi?`, `Kitsune Umi` and the
   * rest of her.
   */
  readonly speaker: string;
  readonly prompts: readonly ChatPrompt[];
  /**
   * What the same NPC says once the question is over — answered, or given up
   * on. An answer still waiting when one of these is heard is not said.
   */
  readonly settledBy: readonly string[];
  /**
   * How long after asking the NPC starts taking an answer, in milliseconds. An
   * answer before then is not heard, so none is sent before then.
   */
  readonly listensAfterMs: number;
  /**
   * How long after asking the NPC stops taking one, in milliseconds. The pause
   * before answering is cut short to fit inside it.
   */
  readonly windowMs: number;
  /**
   * Whether one answer, from anybody, settles it for everyone — so that hearing
   * somebody else say it first makes ours unnecessary.
   */
  readonly anyoneCanAnswer: boolean;
  /** Answered unless the player switches it off. */
  readonly enabledByDefault: boolean;
}

/**
 * How long a `ready` is worth sending for.
 *
 * The NPC waits for it indefinitely; this only bounds how long an answer may
 * sit in the outbound queue before it is dropped as out of date.
 */
const READY_WINDOW_MS = 60_000;

export const CHAT_EVENTS: readonly ChatEvent[] = [
  {
    // Ocean Trench — and, going by the Echo of Cronus telling players to "keep
    // lying to her", her round of the Trials of Cronus. Sometimes — always,
    // under the Alexander's Legacy modifier — she does not die but asks, and
    // gives three Coral Gifts for the answer. Nobody answering within a few
    // seconds is "You speak LIES!", ten seconds of every attack she has at
    // once, and instant death on top of her.
    id: 'thessal',
    label: 'Thessal: "Is King Alexander alive?" — Ocean Trench',
    speaker: 'Thessal',
    prompts: [
      {
        // The name alone, because the wiki has her ask it three ways — "Is King
        // Alexander alive?", "Is King Alexander still alive?", and the legend's
        // "Is Alexander the King alive?" — and in its list of her lines the
        // question is the only one that names him.
        lines: ['Alexander'],
        answer: 'He lives and reigns and conquers the world',
      },
    ],
    settledBy: ['Thank you, kind sailor.', 'You speak LIES!'],
    listensAfterMs: 0,
    // "A few seconds", unmeasured. Small on purpose: the pause is cut to fit
    // it, and an answer that arrives early costs nothing.
    windowMs: 4000,
    anyoneCanAnswer: true,
    enabledByDefault: true,
  },
  {
    // At the shrine east of the arena after the dance, when she is there — more
    // likely the better the dance went. One question of three. Answering it
    // can lead on to the Kitsune Umi fight, which is its own switch below.
    id: 'umiQuestions',
    label: "Village Girl Umi's questions at the shrine — Moonlight Village",
    speaker: 'Umi',
    prompts: [
      {
        // "I was wondering, what kind of foods do you like to eat?"
        lines: ['do you like to eat'],
        answer: 'Mushroom',
      },
      {
        // "Did you have a favorite dancer?"
        lines: ['favorite dancer', 'favourite dancer'],
        answer: 'Carosburg',
      },
      {
        // "What folktales do you know about?"
        lines: ['folktales do you know', 'folk tales do you know'],
        answer: 'The Happy Prince',
      },
    ],
    settledBy: [],
    // The wiki's own advice: "Wait a few seconds before answering."
    listensAfterMs: 3000,
    windowMs: 20_000,
    anyoneCanAnswer: true,
    enabledByDefault: true,
  },
  {
    // What she may ask once her question is answered. Yes takes the group back
    // to the arena and starts Kitsune Umi — a hard secret boss, which plenty of
    // groups leave rather than fight. The exact wording is not on the wiki;
    // this is the phrase it describes.
    id: 'umiKitsune',
    label: 'Umi: yes to "something interesting" — starts the Kitsune Umi fight',
    speaker: 'Umi',
    prompts: [{ lines: ['something interesting'], answer: 'yes' }],
    settledBy: [],
    listensAfterMs: 3000,
    windowMs: 20_000,
    anyoneCanAnswer: true,
    enabledByDefault: false,
  },
  {
    // The hidden room west of the spawn. Yes has her explain the bell, and
    // striking the bell is what starts Challenge Mode — pet stasis for the
    // fight and an extra loot bag, for whoever answered.
    id: 'umiChallenge',
    label: 'Umi: yes to "the thrill of a challenge" — Challenge Mode',
    speaker: 'Umi',
    // "I love the thrill of a challenge! Do you?"
    prompts: [{ lines: ['thrill of a challenge'], answer: 'yes' }],
    settledBy: ['I hope that you’re prepared for it'],
    listensAfterMs: 0,
    windowMs: 20_000,
    anyoneCanAnswer: false,
    enabledByDefault: false,
  },
  {
    // At the dock north of the arena, when she is there instead of the shrine.
    // The game starts when anybody says ready, and scores worse for every
    // second before the Basic Fishing Rods from the barrel are on. Her exact
    // line is not on the wiki, which says only that she tells players to type
    // it.
    id: 'umiFishing',
    label: "Umi's fishing: ready — Moonlight Village",
    speaker: 'Umi',
    prompts: [{ lines: ['say ready', 'type ready'], answer: 'ready' }],
    settledBy: [],
    listensAfterMs: 0,
    windowMs: READY_WINDOW_MS,
    anyoneCanAnswer: true,
    enabledByDefault: false,
  },
  {
    // Before each of the first two stages, and in the White Snake Invasion,
    // which is the same event in other clothes — including the line that says
    // not to say it, which is the joke: saying it is still how it goes on. Not
    // "You said you were 'ready'", which is a taunt mid-wave.
    id: 'skuldReady',
    label: 'Ghost of Skuld: ready — Haunted Cemetery',
    speaker: 'Skuld',
    prompts: [{ lines: ['say ready'], answer: 'ready' }],
    settledBy: [
      'Now that’s what I like to hear!',
      'No time to waste! Let’s get to it.',
      'I expect nothing but a spectacular performance!',
      'Ah… you weren’t supposed to do that!',
    ],
    listensAfterMs: 0,
    windowMs: READY_WINDOW_MS,
    anyoneCanAnswer: true,
    enabledByDefault: true,
  },
  {
    // He introduces the prison and sends the group down one of its branches
    // when somebody says ready. His exact line is not on the wiki; these are
    // the two ways such a line is put. Not his "I'm not ready yet", which is
    // him losing.
    id: 'murcianReady',
    label: 'Soulwarden Murcian: ready — Spectral Penitentiary',
    speaker: 'Murcian',
    prompts: [{ lines: ['say ready', 'type ready'], answer: 'ready' }],
    settledBy: [],
    listensAfterMs: 0,
    windowMs: READY_WINDOW_MS,
    anyoneCanAnswer: true,
    enabledByDefault: true,
  },
  {
    // "…you can always say SKIP and we'll just get on with it." Skipping is
    // what opens the court's portals sooner; once he has said the rest there
    // is nothing left to skip.
    id: 'craigSkip',
    label: 'Craig: skip — Court of Oryx',
    speaker: 'Craig',
    prompts: [{ lines: ['say SKIP'], answer: 'skip' }],
    settledBy: [
      'Ok, ok, jeeze. Give me a moment.',
      'Let me get that for you.',
      'Ok, go up ahead and there should be a gate.',
    ],
    listensAfterMs: 0,
    windowMs: 10_000,
    anyoneCanAnswer: true,
    enabledByDefault: true,
  },
  {
    // The computer at the back of the Beekeeper's room, once he is dead:
    // "Error! Signal to 'The Beekeeper' lost! Log in to 'The Beekeeper'?
    // Password:". The right one prints a research log — lore, not loot. A wrong
    // one earns a hint, and a second wrong one shuts it down for the run, which
    // is why the hint is answered too and why nothing is ever said to it twice.
    id: 'nestComputer',
    label: "The Beekeeper's computer: password — The Nest",
    speaker: 'Computer',
    prompts: [{ lines: ['Password', 'Reminder hint'], answer: 'Dr Terrible' }],
    // Ahead of the prompt, which the first of these would otherwise also be.
    settledBy: ['Password Correct', 'Intruders detected'],
    listensAfterMs: 0,
    windowMs: 20_000,
    anyoneCanAnswer: true,
    enabledByDefault: true,
  },
  {
    // April Fools' 2020, and its security system is still in the game data:
    // use a Hivemaster Helm as Null dies and it asks for this. The portal leads
    // to The Inner Workings — a giant calculator, no loot, no enemies.
    id: 'innerWorkings',
    label: 'Automated Security System: password — The Machine',
    speaker: 'Automated Security System',
    prompts: [{ lines: ['Awaiting administrative password'], answer: 'PPEBTWXD' }],
    settledBy: [],
    listensAfterMs: 0,
    windowMs: 20_000,
    anyoneCanAnswer: true,
    enabledByDefault: true,
  },
];
