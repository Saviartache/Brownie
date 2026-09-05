import {
  MutablePacket,
  Verdict,
  type NativeApi,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it } from 'vitest';

import { createChatFilterPlugin } from '../src/features/chatfilter/chatFilterPlugin.js';
import { scanText } from '../src/features/chatfilter/scanText.js';
import { parseSenderRules } from '../src/features/chatfilter/senderRules.js';
import {
  SPAM_CATEGORIES,
  SPAM_SIGNALS,
  SpamCategory,
  firstMatchingSignal,
} from '../src/features/chatfilter/spamSignals.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import type { SettingsRegistry } from '../src/plugins/SettingsRegistry.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

/** Written as code points, because a pasted lookalike is unreviewable. */
const CYRILLIC_A = String.fromCodePoint(0x0430);
const CYRILLIC_ER = String.fromCodePoint(0x0440);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

const EVERY_CATEGORY: ReadonlySet<SpamCategory> = new Set(Object.values(SpamCategory));

describe('scanning a message', () => {
  /** What the plainly spelled word compacts to, which is what a needle is. */
  const PAYPAL = scanText('paypal').compact;

  it('folds the lookalikes a needle list would otherwise miss', () => {
    // `paypal`, with the Cyrillic twins of its `p` and both its `a`s.
    const disguised = `${CYRILLIC_ER}${CYRILLIC_A}yp${CYRILLIC_A}l`;
    expect(scanText(disguised).compact).toBe(PAYPAL);
  });

  it('drops the invisible characters hidden inside a word', () => {
    expect(scanText(`pay${ZERO_WIDTH_SPACE}pal`).compact).toBe(PAYPAL);
  });

  it('undoes the digits typed in place of a letter, in the compacted form', () => {
    // `l` and `i` are folded together because `1` stands for either.
    expect(scanText('Realm St0ck c0m').compact).toBe(scanText('realmstock com').compact);
    expect(scanText('mu1t1t00l').compact).toBe(scanText('multitool').compact);
    expect(scanText('p@yp4l').compact).toBe(PAYPAL);
  });

  it('leaves the digits alone in every form a signal reads for meaning', () => {
    // `24/7` is a claim rather than a disguise, and the pipe banner reads it.
    const scanned = scanText('24/7 delivery');
    expect(scanned.flat).toBe('24/7 delivery');
    expect(scanned.lower).toBe('24/7 delivery');
  });

  it('keeps the invisible characters in the raw form, where a flood shows', () => {
    const flood = ZERO_WIDTH_SPACE.repeat(60);
    expect(scanText(flood).raw).toHaveLength(60);
    expect(scanText(flood).compact).toBe('');
  });

  it('offers the message as words, with edges, so a short call is one', () => {
    expect(scanText('WTS: pet!').loose).toBe(' wts pet ');
  });

  it('collapses runs of spacing only in the flattened form', () => {
    const scanned = scanText('a   b');
    expect(scanned.flat).toBe('a b');
    expect(scanned.lower).toBe('a   b');
  });

  it('examines a bounded prefix, however long the peer makes the message', () => {
    // The sender chooses this length and every signal below is regular
    // expression work over it.
    expect(scanText('x'.repeat(5000)).raw).toHaveLength(1024);
  });
});

describe('sender rules', () => {
  it('take a plain line as a substring, either case', () => {
    const { rules } = parseSenderRules('SpamBot');
    expect(rules[0]?.matches('xXspambotXx')).toBe(true);
    expect(rules[0]?.matches('someone')).toBe(false);
  });

  it('take a slash line as a pattern, matched against the name as sent', () => {
    // Case is the pattern author's to decide — `/^Xx/` is unusable when the
    // subject has already been folded, so the name is passed through as it came.
    const { rules } = parseSenderRules('/^Xx/');
    expect(rules[0]?.matches('XxTraderxX')).toBe(true);
    expect(rules[0]?.matches('xxtraderxx')).toBe(false);
  });

  it('honour an escaped delimiter inside a pattern', () => {
    const { rules, invalid } = parseSenderRules('/a\\/b/');
    expect(invalid).toEqual([]);
    expect(rules[0]?.matches('a/b')).toBe(true);
  });

  it('refuse the flags that make a pattern stateful', () => {
    // `RegExp.test` on a global pattern resumes from `lastIndex`, so this
    // matched every other message — a filter that looks unreliable, not buggy.
    const { rules } = parseSenderRules('/spam/g');
    const rule = rules[0];
    expect(rule).toBeDefined();
    expect(rule?.matches('spammer')).toBe(true);
    expect(rule?.matches('spammer')).toBe(true);
  });

  it('report a pattern that does not compile instead of dropping it', () => {
    const { rules, invalid } = parseSenderRules('/([unclosed/\ngoodname');
    expect(invalid).toEqual(['/([unclosed/']);
    expect(rules).toHaveLength(1);
  });

  it('ignore blank lines and comments, so a rule can be annotated', () => {
    const { rules } = parseSenderRules('# a note\n\nspambot  # why\n   \n');
    expect(rules.map((rule) => rule.source)).toEqual(['spambot']);
  });
});

describe('the spam signals', () => {
  const reason = (message: string): string | undefined =>
    firstMatchingSignal(scanText(message), EVERY_CATEGORY)?.id;

  it('name themselves once, so a report cannot be ambiguous', () => {
    const ids = SPAM_SIGNALS.map((signal) => signal.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('are all reachable through a category with a switch', () => {
    const switched = new Set(SPAM_CATEGORIES.map((option) => option.category));
    for (const signal of SPAM_SIGNALS) expect(switched.has(signal.category)).toBe(true);
  });

  it.each([
    ['realmstock.com cheapest items', 'shop-domain'],
    // The compacted text has already lost every dot, bracket and space, so one
    // entry covers all of these without a spelling of its own.
    ['hxxps://realmstock.com', 'shop-domain'],
    ['r e a l m s t o c k . c o m', 'shop-domain'],
    ['buy at RealmStock dot com', 'shop-domain'],
    ['rpgstash has pots', 'shop-domain'],
    ['check rotmgarsenal for keys', 'shop-domain'],
    ['realmgoods, automatic delivery', 'shop-domain'],
    ['selling on epicnpc', 'shop-domain'],
    ['oryxsp! best prices', 'shop-domain'],
    // These need the domain beside them: on their own they are things players
    // say. See `SHOP_HOSTS`.
    ['whitebag.net is open again', 'shop-domain'],
    ['realmshop.info oldest store', 'shop-domain'],
    ['rp6.rip pots', 'shop-domain'],
    // A digit typed for the letter it looks like, which is the whole disguise.
    ['Realm St0ck c0m', 'shop-domain'],
    ['rea1mstock.com cheapest', 'shop-domain'],
    ['realm | st0ck | c0m', 'shop-domain'],
    ['che4p f4me service', 'shop-word'],
    ['selling on ep1cnpc', 'shop-domain'],
    ['rp6.shop cheap', 'shop-domain'],
    // Seen in the wild: the dot spelled out so the name is not a domain, and
    // `g` for `6` so it is not the name either.
    ['RP6(dot)RiP - 24/7 Fast Delivery, Maxing, UTs, STs, FP, Buffs, Eggs & More!', 'shop-domain'],
    ['rpg [dot] rip, cheapest', 'shop-domain'],
    ['selling realm items, paypal only, instant delivery', 'shop-word'],
    // The same claim in the third spelling of it, so the banner is still
    // recognised once the bot moves off the domain above.
    ['24/7 fast delivery, maxing, buffs', 'shop-word'],
    ['cheap fame service, message me', 'shop-word'],
    ['pay by venmo or cash app', 'payment-method'],
    ['shipping to your vault today', 'shop-phrase'],
    ['realm | stocks | coins | 24/7 delivery', 'shop-columns'],
    ['visit h t t p s :// shop', 'masked-scheme'],
    ['hxxps://realm.shop', 'masked-scheme'],
    ['go to tinyurl for keys', 'link-shortener'],
    ['join us on telegram', 'off-game-platform'],
    ['deals on discord.gg/shop', 'off-game-platform'],
    ['add me Discord: shopbot', 'off-game-platform'],
    ['r.e.a.l.m.s.h.o.p', 'obfuscated-address'],
    ['buy keys realm dot com', 'obfuscated-address'],
    ['WTS pet, 10 def', 'trade-call'],
    [`=`.repeat(20), 'ascii-banner'],
    [`selling ${'!'.repeat(40)} now`, 'repeated-character'],
  ])('recognise %j as %s', (message, expected) => {
    expect(reason(message)).toBe(expected);
  });

  it.each([
    'anyone want to do a shatters run?',
    'gg that was close',
    'my paladin died to a cube god, rip',
    'trading in nexus, come say hi',
    'that is a nice cloak, where is it from',
    'hi there :)',
    // The shop names that are also things players say. Each of these is one
    // space away from a name in `SHOP_HOSTS`, which is why that list needs a
    // domain after it and `SHOP_BRANDS` does not.
    'got a white bag from oryx!',
    'nice white bag gg',
    'back to the realm, shop later',
    'anyone else play this rpg? rip my streak',
    'the realm stock of pots is gone',
    // The digits that the compacted form folds are still ordinary numbers here.
    'hit 24/7 dps on that boss',
    'need 3 more for a run',
    // A bare mention of the app is not a contact handle: the colon is.
    'anyone on discord tonight?',
  ])('leave %j alone', (message) => {
    expect(reason(message)).toBeUndefined();
  });

  it('recognise a bot tail only on a line no person would type', () => {
    const bot = 'selling realm keys and fame, best prices, vault shipping 482';
    expect(reason(bot)).toBeDefined();
    // The three digits alone are somebody's damage number, not a bot.
    expect(reason('hit for 482')).toBeUndefined();
  });

  it('say nothing while the category that would recognise it is off', () => {
    const trading = new Set([SpamCategory.Trading]);
    const message = scanText('WTS pet, 10 def');
    expect(firstMatchingSignal(message, trading)?.category).toBe(SpamCategory.Trading);
    expect(firstMatchingSignal(message, new Set([SpamCategory.Link]))).toBeUndefined();
    expect(firstMatchingSignal(message, new Set())).toBeUndefined();
  });
});

describe('the chat filter plugin', () => {
  const NATIVE: NativeApi = {
    connected: false,
    setFeature: () => undefined,
    onConnected: () => () => undefined,
  };

  const SELF = 'MyCharacter';

  /** A session api whose connect listeners the test can fire. */
  function sessionApi(): { api: SessionApi; connect: () => void } {
    const listeners: ((session: SessionView) => void)[] = [];
    return {
      api: {
        current: () => undefined,
        all: () => [],
        onConnected: (listener) => {
          listeners.push(listener);
          return () => undefined;
        },
        onDisconnected: () => () => undefined,
      },
      connect: () => {
        for (const listener of listeners) listener(session());
      },
    };
  }

  const notified: string[] = [];

  const session = (): SessionView =>
    ({
      id: 's1',
      self: { name: SELF },
      notify: (text: string) => notified.push(text),
    }) as unknown as SessionView;

  function loadEnabled(): {
    host: PluginHost;
    settings: SettingsRegistry;
    connect: () => void;
  } {
    const { api, connect } = sessionApi();
    const host = new PluginHost({
      log: testLogger(),
      native: NATIVE,
      sessions: api,
      onChanged: () => undefined,
    });
    host.load(createChatFilterPlugin());
    host.setEnabled('chat-filter', true);
    const settings = host.settingsOf('chat-filter');
    if (settings === undefined) throw new Error('the plugin declared no settings');
    notified.length = 0;
    return { host, settings, connect };
  }

  function textPacket(fields: {
    name: string;
    text: string;
    cleanText?: string;
    numStars?: number;
  }): MutablePacket {
    const packet = createPacket(registry, 'TEXT');
    Object.assign(packet.fields, {
      name: fields.name,
      objectId: 7,
      numStars: fields.numStars ?? 12,
      bubbleTime: 0,
      recipient: '',
      text: fields.text,
      cleanText: fields.cleanText ?? fields.text,
      isSupporter: false,
      starBg: 0,
    });
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  /** Whether a message reaches the game client. */
  function shown(host: PluginHost, fields: Parameters<typeof textPacket>[0]): boolean {
    const packet = textPacket(fields);
    host.dispatchPacket(packet, session());
    return packet.verdict === Verdict.Forward;
  }

  it('hides a spam message and leaves an ordinary one alone', () => {
    const { host } = loadEnabled();
    expect(shown(host, { name: 'ShopBot', text: 'cheap fame, paypal only' })).toBe(false);
    expect(shown(host, { name: 'Friend', text: 'want to do a shatters?' })).toBe(true);
  });

  it('reads the message the client will draw when the clean copy is blank', () => {
    const { host } = loadEnabled();
    expect(shown(host, { name: 'ShopBot', text: 'cheap fame, paypal only', cleanText: '' })).toBe(
      false,
    );
  });

  it('never examines the player, the server or an npc', () => {
    const { host } = loadEnabled();
    // Everything below would be hidden if it came from another player.
    expect(shown(host, { name: SELF, text: 'cheap fame, paypal only' })).toBe(true);
    expect(shown(host, { name: '', text: 'cheap fame, paypal only' })).toBe(true);
    expect(shown(host, { name: '*', text: 'cheap fame, paypal only' })).toBe(true);
    expect(shown(host, { name: 'Oryx', text: 'cheap fame, paypal only', numStars: -1 })).toBe(true);
  });

  it('hides a blocked sender whatever they say', () => {
    const { host, settings } = loadEnabled();
    settings.apply('blockList', 'ShopBot\n/^Rmt/i');
    expect(shown(host, { name: 'ShopBot', text: 'hello' })).toBe(false);
    expect(shown(host, { name: 'rmtSeller', text: 'hello' })).toBe(false);
    expect(shown(host, { name: 'Friend', text: 'hello' })).toBe(true);
  });

  it('shows an allowed sender a message that would otherwise be hidden', () => {
    const { host, settings } = loadEnabled();
    settings.apply('allowList', 'Friend');
    expect(shown(host, { name: 'Friend', text: 'WTS pet, 10 def' })).toBe(true);
    expect(shown(host, { name: 'Stranger', text: 'WTS pet, 10 def' })).toBe(false);
  });

  it('lets a block beat an allow, because a name is the more deliberate line', () => {
    const { host, settings } = loadEnabled();
    settings.apply('allowList', '/./');
    settings.apply('blockList', 'ShopBot');
    expect(shown(host, { name: 'ShopBot', text: 'hello' })).toBe(false);
  });

  it('shows everything again once its categories are switched off', () => {
    const { host, settings } = loadEnabled();
    for (const option of SPAM_CATEGORIES) settings.apply(option.key, false);
    expect(shown(host, { name: 'ShopBot', text: 'cheap fame, paypal only' })).toBe(true);
  });

  it('switches off one category without touching the others', () => {
    const { host, settings } = loadEnabled();
    settings.apply('hideTrading', false);
    expect(shown(host, { name: 'Trader', text: 'WTS pet, 10 def' })).toBe(true);
    expect(shown(host, { name: 'ShopBot', text: 'cheap fame, paypal only' })).toBe(false);
  });

  it('reports what it hid, and why, when asked', () => {
    const { host } = loadEnabled();
    expect(shown(host, { name: 'ShopBot', text: 'cheap fame, paypal only' })).toBe(false);
    expect(shown(host, { name: 'Trader', text: 'WTS pet' })).toBe(false);

    host.dispatchCommand('chatfilter', [], session());
    const report = notified.at(-1) ?? '';
    expect(report).toContain('2 hidden');
    expect(report).toContain('shop-word');
    expect(report).toContain('Trader');
  });

  it('starts its count again with a new session', () => {
    const { host, connect } = loadEnabled();
    expect(shown(host, { name: 'ShopBot', text: 'cheap fame, paypal only' })).toBe(false);

    connect();
    host.dispatchCommand('chatfilter', [], session());
    expect(notified.at(-1)).toContain('nothing hidden');
  });
});
