import {
  MutablePacket,
  PluginState,
  type SendOptions,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket, type FieldValue } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it } from 'vitest';

import {
  LATE_LIMIT_MS,
  PAUSE_SPREAD,
  REPEAT_QUIET_MS,
  TRIP_ALLOWANCE_MS,
  createAutoResponsePlugin,
} from '../src/features/autoresponse/autoResponsePlugin.js';
import { CHAT_EVENTS, type ChatEvent } from '../src/features/autoresponse/chatEvents.js';
import { foldEvents, foldLine, hearNpcLine } from '../src/features/autoresponse/npcLines.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

/** The star count the server gives a line nobody with a character said. */
const NPC_STARS = -1;

// Events written for these tests, so that none of them depends on the
// catalogue — which is tested on its own further down.

const MERMAID: ChatEvent = {
  id: 'mermaid',
  label: 'Mermaid — Test Trench',
  speaker: 'Mermaid Goddess',
  prompts: [{ lines: ['Is the king alive?'], answer: 'He lives and reigns' }],
  settledBy: ['Thank you, kind sailor.', 'You speak LIES!'],
  listensAfterMs: 0,
  windowMs: 5000,
  anyoneCanAnswer: true,
  enabledByDefault: true,
};

/** Two questions from one NPC, answered by whoever was asked, a while after. */
const QUIZ: ChatEvent = {
  id: 'quiz',
  label: 'Quiz Girl — Test Village',
  speaker: 'Quiz Girl',
  prompts: [
    { lines: ['favorite dancer', 'favourite dancer'], answer: 'Carosburg' },
    { lines: ['Which folktales do you know?'], answer: 'The Fox' },
  ],
  settledBy: [],
  listensAfterMs: 3000,
  windowMs: 20_000,
  anyoneCanAnswer: false,
  enabledByDefault: true,
};

/** A password, and a hint that asks for the same one again. */
const TERMINAL: ChatEvent = {
  id: 'terminal',
  label: 'Terminal — Test Nest',
  speaker: 'Terminal',
  prompts: [{ lines: ['Password', 'Reminder hint'], answer: 'Dr Terrible' }],
  settledBy: ['Password Correct'],
  listensAfterMs: 0,
  windowMs: 20_000,
  anyoneCanAnswer: true,
  enabledByDefault: true,
};

/** One the player has to switch on. */
const READY_CHECK: ChatEvent = {
  id: 'readyCheck',
  label: 'Gatekeeper — Test Arena',
  speaker: 'Gatekeeper',
  prompts: [{ lines: ['say ready'], answer: 'ready' }],
  settledBy: [],
  listensAfterMs: 0,
  windowMs: 60_000,
  anyoneCanAnswer: true,
  enabledByDefault: false,
};

const TEST_EVENTS: readonly ChatEvent[] = [MERMAID, QUIZ, TERMINAL, READY_CHECK];

describe('folding a line', () => {
  it('keeps the words and nothing else, padded so a phrase matches whole words', () => {
    expect(foldLine('Is King Alexander ALIVE?!')).toBe(' is king alexander alive ');
    expect(foldLine('  Say ‘READY’,   now…  ')).toBe(' say ready now ');
  });

  it('folds straight and curly apostrophes alike', () => {
    expect(foldLine('Now that’s what I like')).toBe(foldLine("Now that's what I like"));
  });

  it('drops accents, so a transcription without them still matches', () => {
    expect(foldLine('Café Déjà')).toBe(' cafe deja ');
  });

  it('folds a line with no word in it to nothing', () => {
    expect(foldLine('?!...')).toBe('');
    expect(foldLine('')).toBe('');
  });

  it('reads a bounded prefix, however long the server makes the line', () => {
    expect(foldLine('word '.repeat(10_000)).length).toBeLessThan(600);
  });
});

describe('hearing an NPC', () => {
  const events = foldEvents(TEST_EVENTS);

  it('recognises a question from the NPC that asks it, however its name is written', () => {
    for (const speaker of ['#Mermaid Goddess', 'Mermaid Goddess', '#MERMAID GODDESS?']) {
      const heard = hearNpcLine(events, speaker, 'Is the king alive?');
      expect(heard?.kind).toBe('prompt');
      expect(heard?.event).toBe(MERMAID);
    }
  });

  it('knows a speaker by whole words of the name', () => {
    const heard = hearNpcLine(events, '#Thessal the Mermaid Goddess', 'Is the king alive?');
    expect(heard?.kind).toBe('prompt');
    expect(hearNpcLine(events, '#Mermaid Goddesses', 'Is the king alive?')).toBeUndefined();
  });

  it('finds the question inside a longer line, whatever its case and punctuation', () => {
    const heard = hearNpcLine(events, '#Mermaid Goddess', 'Sailor! IS THE KING ALIVE??');
    expect(heard?.kind).toBe('prompt');
  });

  it('never finds a phrase inside a word', () => {
    expect(hearNpcLine(events, '#Gatekeeper', 'Say, READY!')?.kind).toBe('prompt');
    expect(hearNpcLine(events, '#Gatekeeper', 'Say already')?.kind).toBe('other');
  });

  it('takes any of the ways a question is put', () => {
    for (const line of ['Your favorite dancer?', 'Your favourite dancer?']) {
      const heard = hearNpcLine(events, '#Quiz Girl?', line);
      expect(heard?.kind === 'prompt' && heard.prompt.source.answer).toBe('Carosburg');
    }
  });

  it('tells each of an NPC’s questions apart', () => {
    const folktales = hearNpcLine(events, '#Quiz Girl?', 'Which folktales do you know?');
    expect(folktales?.kind === 'prompt' && folktales.prompt.source.answer).toBe('The Fox');
  });

  it('knows the lines that end the question', () => {
    expect(hearNpcLine(events, '#Mermaid Goddess', 'Thank you kind sailor')?.kind).toBe('settled');
    expect(hearNpcLine(events, '#Mermaid Goddess', 'You speak LIES!')?.kind).toBe('settled');
  });

  it('takes a line that ends the question for that, even when it holds the question', () => {
    const heard = hearNpcLine(events, '#Terminal', 'Password Correct… loading Research Logs…');
    expect(heard?.kind).toBe('settled');
    expect(hearNpcLine(events, '#Terminal', 'Password:')?.kind).toBe('prompt');
  });

  it('reports anything else the NPC says, for the log', () => {
    const heard = hearNpcLine(events, '#Mermaid Goddess', 'The sea will swallow you!');
    expect(heard?.kind).toBe('other');
    expect(heard?.event).toBe(MERMAID);
  });

  it('has nothing to say about an NPC no event names', () => {
    expect(hearNpcLine(events, '#Oryx the Mad God', 'Is the king alive?')).toBeUndefined();
    expect(hearNpcLine(events, '', 'Is the king alive?')).toBeUndefined();
  });

  it('refuses a catalogue entry that could match everything or nothing', () => {
    const wordless = { ...MERMAID, prompts: [{ lines: ['?!'], answer: 'yes' }] };
    expect(() => foldEvents([wordless])).toThrow(/has no word in it/);
    const lineless = { ...MERMAID, prompts: [{ lines: [], answer: 'yes' }] };
    expect(() => foldEvents([lineless])).toThrow(/has no line/);
    expect(() => foldEvents([{ ...MERMAID, speaker: '#' }])).toThrow(/has no word in it/);
  });
});

describe('the catalogue', () => {
  it('folds', () => {
    expect(() => foldEvents(CHAT_EVENTS)).not.toThrow();
  });

  it('names every event once, with a key a setting can have', () => {
    const ids = CHAT_EVENTS.map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][A-Za-z0-9]*$/);
    // `pauseMs` is the plugin's own setting, and an event switch named the
    // same would be one stored value read as two.
    expect(ids).not.toContain('pauseMs');
  });

  it('answers only with what the chat box would send as chat', () => {
    for (const event of CHAT_EVENTS) {
      for (const { answer } of event.prompts) {
        expect(answer.trim()).toBe(answer);
        expect(answer).not.toBe('');
        expect(answer.startsWith('/')).toBe(false);
      }
    }
  });

  it('recognises every way of every question as that question', () => {
    const events = foldEvents(CHAT_EVENTS);
    for (const event of CHAT_EVENTS) {
      for (const prompt of event.prompts) {
        for (const line of prompt.lines) {
          const heard = hearNpcLine(events, `#${event.speaker}`, line);
          expect(heard?.kind === 'prompt' && heard.prompt.source).toBe(prompt);
        }
      }
    }
  });

  it('recognises every line that ends a question as that', () => {
    const events = foldEvents(CHAT_EVENTS);
    for (const event of CHAT_EVENTS) {
      for (const line of event.settledBy) {
        const heard = hearNpcLine(events, `#${event.speaker}`, line);
        expect(heard?.kind).toBe('settled');
        expect(heard?.event).toBe(event);
      }
    }
  });

  it('gives every event room to be answered in', () => {
    for (const event of CHAT_EVENTS) {
      expect(event.listensAfterMs).toBeGreaterThanOrEqual(0);
      expect(event.windowMs - TRIP_ALLOWANCE_MS).toBeGreaterThanOrEqual(event.listensAfterMs);
    }
  });

  it('answers Thessal however the wiki writes her question', () => {
    const events = foldEvents(CHAT_EVENTS);
    for (const line of [
      'Is King Alexander alive?',
      'Is King Alexander still alive?',
      'Is Alexander the King alive?',
    ]) {
      const heard = hearNpcLine(events, '#Thessal the Mermaid Goddess', line);
      expect(heard?.kind === 'prompt' && heard.prompt.source.answer).toBe(
        'He lives and reigns and conquers the world',
      );
    }
    const thanks = hearNpcLine(events, '#Thessal the Mermaid Goddess', 'Thank you kind sailor.');
    expect(thanks?.kind).toBe('settled');
  });

  it('answers Umi’s three questions, as the wiki writes them', () => {
    const events = foldEvents(CHAT_EVENTS);
    const answers = [
      'I was wondering, what kind of foods do you like to eat?',
      'Did you have a favorite dancer?',
      'What folktales do you know about?',
    ].map((line) => {
      const heard = hearNpcLine(events, '#Village Girl Umi?', line);
      return heard?.kind === 'prompt' ? heard.prompt.source.answer : undefined;
    });
    expect(answers).toEqual(['Mushroom', 'Carosburg', 'The Happy Prince']);
  });

  it('never answers Umi’s first-time question, which puts the group on Leisurely', () => {
    const events = foldEvents(CHAT_EVENTS);
    const heard = hearNpcLine(
      events,
      '#Village Girl Umi?',
      'Is this your first time at the festival?',
    );
    expect(heard?.kind).toBe('other');
  });

  it('says ready to Skuld whichever way he asks, and not to his taunt', () => {
    const events = foldEvents(CHAT_EVENTS);
    const ghost = '#Ghost of Skuld';
    for (const line of [
      'Prepare yourself… and say ‘READY’ when you wish the battle to begin!',
      'Say, ‘READY’ when you are ready to face your opponents.',
      'Prepare yourself…Say ‘READY’ when you wish the battle to begin!',
      'Say ‘READY’ when you are prepared to be relentlessly crushed.',
    ]) {
      const heard = hearNpcLine(events, ghost, line);
      expect(heard?.kind === 'prompt' && heard.prompt.source.answer).toBe('ready');
    }
    expect(hearNpcLine(events, ghost, 'You said you were ‘ready’.')?.kind).toBe('other');
    expect(hearNpcLine(events, ghost, 'Now that’s what I like to hear!')?.kind).toBe('settled');
  });

  it('keeps the Beekeeper’s computer from taking its own “Password Correct” for a question', () => {
    const events = foldEvents(CHAT_EVENTS);
    const correct = 'Password Correct… loading Research Logs…';
    expect(hearNpcLine(events, '#Computer', correct)?.kind).toBe('settled');
    const hint = hearNpcLine(events, '#Computer', 'Incorrect… Reminder hint: It’s me.');
    expect(hint?.kind === 'prompt' && hint.prompt.source.answer).toBe('Dr Terrible');
  });
});

describe('the auto-response plugin', () => {
  const SELF = 'Brownie';
  const PLUGIN = 'auto-response';

  interface Said {
    readonly packetName: string;
    readonly text: string;
    readonly options: SendOptions | undefined;
  }

  interface Harness {
    readonly host: PluginHost;
    readonly said: Said[];
    advance: (ms: number) => void;
    /** A tick, which is what lets a waiting answer go. */
    tick: () => void;
    /** An NPC's line. */
    npc: (speaker: string, text: string) => void;
    /** A player's line, said aloud unless it names who it is for. */
    player: (name: string, text: string, recipient?: string) => void;
    mapinfo: () => void;
    setting: (key: string, value: boolean | number) => void;
  }

  /**
   * @param randoms What `random` returns, in turn, repeating the last one. The
   *   plugin draws one per answer, for its pause.
   */
  function harness(randoms: readonly number[] = [0.5]): Harness {
    const world = { gameTimeMs: 100_000 };
    const said: Said[] = [];
    let draw = 0;
    const random = (): number => randoms[Math.min(draw++, randoms.length - 1)] ?? 0.5;

    const session = {
      id: 's1',
      self: { name: SELF },
      world: {
        get gameTimeMs(): number {
          return world.gameTimeMs;
        },
      },
      sendToServer: (
        packetName: string,
        fields: Readonly<Record<string, unknown>>,
        options?: SendOptions,
      ): void => {
        said.push({ packetName, text: String(fields.text), options });
      },
      notify: () => undefined,
    } as unknown as SessionView;

    const sessions: SessionApi = {
      current: () => session,
      all: () => [session],
      onConnected: () => () => undefined,
      onDisconnected: () => () => undefined,
    };

    const host = new PluginHost({
      log: testLogger(),
      native: { connected: false, setFeature: () => undefined, onConnected: () => () => undefined },
      sessions,
      onChanged: () => undefined,
    });
    host.load(createAutoResponsePlugin({ events: TEST_EVENTS, random }));
    host.setEnabled(PLUGIN, true);

    const dispatch = (name: string, fields: Record<string, FieldValue>): void => {
      const packet = createPacket(registry, name);
      Object.assign(packet.fields, fields);
      host.dispatchPacket(
        new MutablePacket(decodeFrame(registry, encodePacket(registry, packet))),
        session,
      );
    };
    const text = (
      name: string,
      stars: number,
      line: string,
      recipient: string,
    ): Record<string, FieldValue> => ({
      name,
      objectId: 7,
      numStars: stars,
      bubbleTime: 5,
      recipient,
      text: line,
      cleanText: line,
      isSupporter: false,
      starBg: 0,
    });

    return {
      host,
      said,
      advance: (ms): void => {
        world.gameTimeMs += ms;
      },
      tick: (): void => {
        dispatch('NEWTICK', {
          tickId: 0,
          tickTime: 200,
          serverRealTimeMs: 0,
          serverLastRttMs: 0,
          statuses: [],
        });
      },
      npc: (speaker, line): void => {
        dispatch('TEXT', text(`#${speaker}`, NPC_STARS, line, ''));
      },
      player: (name, line, recipient = ''): void => {
        dispatch('TEXT', text(name, 40, line, recipient));
      },
      mapinfo: (): void => {
        dispatch('MAPINFO', {
          width: 1,
          height: 1,
          name: 'Ocean Trench',
          displayName: 'Ocean Trench',
          realmName: '',
          fp: 0,
          background: 0,
          difficulty: 0,
          allowTeleport: true,
          showDisplays: true,
          maxPlayers: 0,
          gameOpenedTime: 0,
          buildVersion: '',
          unknown: 0,
        });
      },
      setting: (key, value): void => {
        const settings = host.settingsOf(PLUGIN);
        if (settings === undefined) throw new Error('the plugin declared no settings');
        expect(settings.apply(key, value)).toBe(true);
      },
    };
  }

  /** The longest pause the default setting can draw. */
  const LONGEST_PAUSE_MS = 1500 * (1 + PAUSE_SPREAD);

  /** Lets any pause an event with nothing to wait for can draw run out. */
  const afterThePause = (h: Harness): void => {
    h.advance(LONGEST_PAUSE_MS);
    h.tick();
  };

  const texts = (h: Harness): string[] => h.said.map((line) => line.text);

  it('answers the question in chat', () => {
    const h = harness();
    h.npc('Mermaid Goddess', 'Is the king alive?');
    afterThePause(h);

    expect(h.said).toEqual([
      expect.objectContaining({ packetName: 'PLAYERTEXT', text: 'He lives and reigns' }),
    ]);
  });

  it('waits out a pause of about the chosen length first', () => {
    // The lowest draw: the pause less its whole spread.
    const h = harness([0]);
    const pauseMs = 1500 * (1 - PAUSE_SPREAD);
    h.npc('Mermaid Goddess', 'Is the king alive?');

    h.tick();
    h.advance(pauseMs - 1);
    h.tick();
    expect(h.said).toHaveLength(0);

    h.advance(1);
    h.tick();
    expect(h.said).toHaveLength(1);
  });

  it('counts the pause from when the NPC starts listening', () => {
    const h = harness([0]);
    h.setting('pauseMs', 0);
    h.npc('Quiz Girl', 'Did you have a favorite dancer?');

    h.advance(QUIZ.listensAfterMs - 1);
    h.tick();
    expect(h.said).toHaveLength(0);

    h.advance(1);
    h.tick();
    expect(texts(h)).toEqual(['Carosburg']);
  });

  it('cuts the pause short to leave the answer time to arrive', () => {
    // The longest pause the setting allows, and more than the window has room for.
    const h = harness([0.999]);
    h.setting('pauseMs', 5000);
    h.npc('Mermaid Goddess', 'Is the king alive?');

    h.advance(MERMAID.windowMs - TRIP_ALLOWANCE_MS - 1);
    h.tick();
    expect(h.said).toHaveLength(0);

    h.advance(1);
    h.tick();
    expect(h.said).toHaveLength(1);
  });

  it('answers each question with its own answer', () => {
    const h = harness();
    h.npc('Quiz Girl', 'Did you have a favorite dancer?');
    h.advance(QUIZ.listensAfterMs);
    afterThePause(h);
    h.npc('Quiz Girl', 'Which folktales do you know?');
    h.advance(QUIZ.listensAfterMs);
    afterThePause(h);

    expect(texts(h)).toEqual(['Carosburg', 'The Fox']);
  });

  it('queues two questions asked together as two answers', () => {
    const h = harness();
    h.npc('Quiz Girl', 'Did you have a favorite dancer?');
    h.npc('Quiz Girl', 'Which folktales do you know?');
    h.advance(QUIZ.listensAfterMs);
    afterThePause(h);

    expect(texts(h)).toEqual(['Carosburg', 'The Fox']);
    expect(h.said[0]?.options?.key).not.toBe(h.said[1]?.options?.key);
  });

  it('answers only once for a question asked twice', () => {
    const h = harness();
    h.npc('Mermaid Goddess', 'Is the king alive?');
    h.npc('Mermaid Goddess', 'Is the king alive?');
    for (let i = 0; i < 10; i += 1) afterThePause(h);

    expect(h.said).toHaveLength(1);
  });

  it('does not give an NPC the same answer twice in a row, but does later', () => {
    const h = harness();
    h.npc('Mermaid Goddess', 'Is the king alive?');
    afterThePause(h);
    h.npc('Mermaid Goddess', 'Is the king alive?');
    afterThePause(h);
    expect(h.said).toHaveLength(1);

    h.advance(REPEAT_QUIET_MS);
    h.npc('Mermaid Goddess', 'Is the king alive?');
    afterThePause(h);
    expect(h.said).toHaveLength(2);
  });

  it('does not repeat an answer the NPC asks for a second way', () => {
    // A hint after the password: saying it again is a second wrong answer.
    const h = harness();
    h.npc('Terminal', 'Password:');
    afterThePause(h);
    h.npc('Terminal', 'Incorrect… Reminder hint: It’s me.');
    afterThePause(h);

    expect(texts(h)).toEqual(['Dr Terrible']);
  });

  it('answers once when somebody else gets the password wrong first', () => {
    const h = harness();
    h.npc('Terminal', 'Password:');
    h.player('Guesser', 'hunter2');
    h.npc('Terminal', 'Incorrect… Reminder hint: It’s me.');
    afterThePause(h);

    expect(texts(h)).toEqual(['Dr Terrible']);
  });

  it('never answers a player who says the question', () => {
    const h = harness();
    h.player('Prankster', 'Is the king alive?');
    afterThePause(h);

    expect(h.said).toHaveLength(0);
  });

  it('never answers a player whose star count is not negative, whatever the name', () => {
    const h = harness();
    h.player('#Mermaid Goddess', 'Is the king alive?');
    afterThePause(h);

    expect(h.said).toHaveLength(0);
  });

  it('leaves alone an event switched off, and answers it once switched on', () => {
    const h = harness();
    h.npc('Gatekeeper', 'Say ready!');
    afterThePause(h);
    expect(h.said).toHaveLength(0);

    h.setting('readyCheck', true);
    h.npc('Gatekeeper', 'Say ready!');
    afterThePause(h);
    expect(texts(h)).toEqual(['ready']);
  });

  it('stays quiet when somebody else says the answer first', () => {
    const h = harness();
    h.npc('Mermaid Goddess', 'Is the king alive?');
    h.player('Sailor', 'he lives and reigns!');
    afterThePause(h);

    expect(h.said).toHaveLength(0);
  });

  it('stays quiet when the player types the answer by hand', () => {
    const h = harness();
    h.npc('Mermaid Goddess', 'Is the king alive?');
    h.player(SELF, 'He lives and reigns');
    afterThePause(h);

    expect(h.said).toHaveLength(0);
  });

  it('still answers when somebody else only says something like it', () => {
    const h = harness();
    h.npc('Mermaid Goddess', 'Is the king alive?');
    h.player('Sailor', 'he lives');
    h.player('Sailor', 'is it he lives and reigns?');
    afterThePause(h);

    expect(h.said).toHaveLength(1);
  });

  it('does not count an answer whispered to somebody', () => {
    const h = harness();
    h.npc('Mermaid Goddess', 'Is the king alive?');
    h.player('Sailor', 'He lives and reigns', SELF);
    afterThePause(h);

    expect(h.said).toHaveLength(1);
  });

  it('answers a question put to each player even when another has answered it', () => {
    const h = harness();
    h.npc('Quiz Girl', 'Did you have a favorite dancer?');
    h.player('Dancer', 'Carosburg');
    h.advance(QUIZ.listensAfterMs);
    afterThePause(h);

    expect(texts(h)).toEqual(['Carosburg']);
  });

  it('drops the answer when the NPC settles the question first', () => {
    const h = harness();
    h.npc('Mermaid Goddess', 'Is the king alive?');
    h.npc('Mermaid Goddess', 'Thank you, kind sailor.');
    afterThePause(h);

    expect(h.said).toHaveLength(0);
  });

  it('drops the answer when the map changes', () => {
    const h = harness();
    h.npc('Mermaid Goddess', 'Is the king alive?');
    h.mapinfo();
    afterThePause(h);

    expect(h.said).toHaveLength(0);
  });

  it('drops an answer that waited while the plugin was off, and is not stuck on it', () => {
    const h = harness();
    h.setting('readyCheck', true);
    h.npc('Gatekeeper', 'Say ready!');
    h.host.setEnabled(PLUGIN, false);
    h.advance(LONGEST_PAUSE_MS + LATE_LIMIT_MS + 1);
    h.tick();
    h.host.setEnabled(PLUGIN, true);
    h.tick();
    expect(h.said).toHaveLength(0);

    h.npc('Gatekeeper', 'Say ready!');
    afterThePause(h);
    expect(texts(h)).toEqual(['ready']);
  });

  it('asks the queue to send it once, and not after the NPC stops listening', () => {
    const h = harness([0]);
    h.npc('Mermaid Goddess', 'Is the king alive?');
    afterThePause(h);

    const options = h.said[0]?.options;
    expect(options?.key).toMatch(/^auto-response:mermaid:/);
    // What is left of the window at the tick that sent it.
    expect(options?.expiresInMs).toBe(MERMAID.windowMs - LONGEST_PAUSE_MS);
  });

  it('says nothing while switched off', () => {
    const h = harness();
    h.host.setEnabled(PLUGIN, false);
    h.npc('Mermaid Goddess', 'Is the king alive?');
    afterThePause(h);

    expect(h.said).toHaveLength(0);
  });

  it('fails alone on a catalogue it cannot fold, leaving the rest of the runtime be', () => {
    const host = new PluginHost({
      log: testLogger(),
      native: { connected: false, setFeature: () => undefined, onConnected: () => () => undefined },
      sessions: {
        current: () => undefined,
        all: () => [],
        onConnected: () => () => undefined,
        onDisconnected: () => () => undefined,
      },
      onChanged: () => undefined,
    });
    const broken = { ...MERMAID, speaker: '?' };
    const status = host.load(createAutoResponsePlugin({ events: [broken] }));
    expect(status.state).toBe(PluginState.Failed);
    expect(status.error).toMatch(/has no word in it/);
  });
});
