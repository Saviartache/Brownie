/**
 * What the filter recognises, and under which heading.
 *
 * A table of named signals rather than one `matchesSpam(): boolean`. Two things
 * follow from that, and both are the reason for the shape:
 *
 * A hidden message can say *why* it was hidden. The reference implementation
 * returned a bare boolean out of a two-hundred-line function, so a false
 * positive — a friend's message that never arrived — was undiagnosable by
 * anyone, including its author. Here the signal's id is what `/chatfilter`
 * prints and what the log records.
 *
 * And a category can be switched off. Blocking every `WTS` line is right for a
 * player who never trades and wrong for one who does, and that is a decision
 * the person reading the chat should be making rather than this file.
 *
 * Nothing here reaches the network, and a signal is a pure function of one
 * message, which is what lets every one of them be tested against the lines
 * that motivated it.
 */

import type { ScannedText } from './scanText.js';

/** The headings a signal is filed under, and switched on and off by. */
export const SpamCategory = {
  /** Shops, services, payment methods — someone selling something for money. */
  Advertising: 'advertising',
  /** `WTS` / `WTB` calls, which are in-game trade rather than commerce. */
  Trading: 'trading',
  /** A link, or something written to look like anything but a link. */
  Link: 'link',
  /** Banners, character runs, bot tails — noise rather than a message. */
  Flood: 'flood',
} as const;

export type SpamCategory = (typeof SpamCategory)[keyof typeof SpamCategory];

/** One category, and the setting that governs it. */
export interface SpamCategoryOption {
  readonly category: SpamCategory;
  /**
   * The key its switch persists under.
   *
   * Stable: renaming one silently loses whatever the user had set.
   */
  readonly key: string;
  readonly label: string;
  /** Whether it is on for a player who has never touched the settings. */
  readonly enabledByDefault: boolean;
}

export const SPAM_CATEGORIES: readonly SpamCategoryOption[] = [
  {
    category: SpamCategory.Advertising,
    key: 'hideAdvertising',
    label: 'Shops, services and payment offers',
    enabledByDefault: true,
  },
  {
    category: SpamCategory.Link,
    key: 'hideLinks',
    label: 'Links, shorteners and disguised addresses',
    enabledByDefault: true,
  },
  {
    category: SpamCategory.Flood,
    key: 'hideFlood',
    label: 'Banners, repeated characters and bot tails',
    enabledByDefault: true,
  },
  {
    category: SpamCategory.Trading,
    key: 'hideTrading',
    label: 'Trade calls (WTS, WTB, WTT)',
    enabledByDefault: true,
  },
];

/** One thing worth recognising in a message. */
export interface SpamSignal {
  /** Stable and kebab-case: it is what a hidden message is reported as. */
  readonly id: string;
  readonly category: SpamCategory;
  matches(text: ScannedText): boolean;
}

/**
 * Words that survive having their punctuation and spacing removed.
 *
 * Matched against {@link ScannedText.compact}, so `gift card`, `gift-card` and
 * `g i f t c a r d` are all one entry here. Stems rather than whole phrases for
 * the same reason: `giftcard` covers the plural without a second line.
 */
const SHOP_WORDS: readonly string[] = [
  'multitool',
  'nexusmaxing',
  'fameservice',
  'famreservice',
  'whitebagandfame',
  'cheapfame',
  'instantdelivery',
  'autodelivery',
  'fastdelivery',
  'giftcard',
  'dailylottery',
  'freespins',
  'seasonalitems',
  'bulkkeys',
  'ssndecas',
  'enchanteddeca',
  'leancrown',
  'r2wins',
  'r2realm',
  'coinsstocks',
];

/**
 * The shops themselves, by name.
 *
 * Matched against {@link ScannedText.compact}, where every dot, bracket and
 * space is already gone — so one entry covers `realmstock.com`,
 * `realmstock[.]com`, `r e a l m s t o c k . c o m` and `hxxps://realmstock.com`
 * without a spelling of its own for each.
 *
 * **Two lists, because the names are not equally distinctive.** These below can
 * be recognised on their own: none of them is something a player types by
 * accident.
 */
const SHOP_BRANDS: readonly string[] = [
  'rpgstash',
  'rotmgarsenal',
  'realmgoods',
  'epicnpc',
  'oryxsp',
];

/**
 * And these cannot, so they are only a shop with a domain after them.
 *
 * `whitebag` is what everybody calls a white bag, `realmshop` is one space away
 * from "the realm, shop later", `realmstock` is one space away from the pipe
 * banner two signals below, and `rp6` is three characters. Requiring the
 * top-level domain is what keeps `got a white bag!` out of the filter — and each
 * of those four messages is in the suite as a line to leave alone.
 *
 * `rp6` and `pr6` are the operator's own sighting rather than something a search
 * could confirm, which is why they are in the list that needs a domain beside
 * them rather than the one that does not.
 */
const SHOP_HOSTS: readonly string[] = ['realmstock', 'whitebag', 'realmshop', 'rp6', 'pr6'];

/**
 * Where these turn up, and **only where they have been seen to**.
 *
 * A longer list is not a safer one: it was written with `gg` in it, and
 * `white bag gg` — an ordinary thing to say about an ordinary drop — became
 * spam.
 */
const SHOP_TLDS = 'com|net|info|shop';

/**
 * A shop name followed by a domain, with `dot` spelled out or not.
 *
 * Built rather than written out: five hand-written variants of the same shape is
 * five chances to get one wrong, and the shape is the whole point.
 */
const SHOP_DOMAINS: readonly RegExp[] = SHOP_HOSTS.map(
  (host) => new RegExp(`${host}(?:dot)?(?:${SHOP_TLDS})`),
);

/**
 * The shop whose name and domain are both ordinary words, so the dot itself has
 * to be there.
 *
 * `rp6.rip` cannot go in the list above at any strictness: compacted, `rpg` and
 * `rip` sit next to each other in `anyone else play this rpg? rip my streak`,
 * and `.rip` is not a top-level domain `SHOP_TLDS` can carry for every host —
 * `got a white bag, rip` would become spam. Matched against the flattened text
 * instead, where a separator that is not a dot is still a separator.
 *
 * `rp6` is the name; `rpg` is the same line with the digit typed back as the
 * letter it is standing in for, and the bot writes the dot out as `(dot)` or
 * `[dot]` so that neither form reads as a domain.
 */
const SHOP_ADDRESSES: readonly RegExp[] = [/\brp[6g]\s*[.[(]\s*(?:dot\s*[)\]]?\s*)?rip\b/];

/** Phrases the word list cannot express, matched against the flattened text. */
const SHOP_PHRASES: readonly RegExp[] = [
  /\bshipping\s+(?:to\s+)?your\s+vault\b/,
  /\b(?:win|get)\s+season'?s\s+items?\b/,
  /\benchanted\s+rare\b/,
];

/** How money changes hands, which an in-game trade never involves. */
const PAYMENT_METHODS = /pay\s*pal|venmo|zelle|cash\s*app|\bcrypto\b|\bbtc\b|\busdt\b/;

/** What a banner laid out in columns is selling. */
const PIPE_SHOP_HINTS =
  /pay\s*pal|venmo|zelle|\bcrypto\b|[$€£]|gift\s*card|instant|delivery|24\s*[/ ]\s*7|\bstocks?\b|\bcoins?\b/;

/** `realm | stock | coins`, in the spellings that keep it out of a word list. */
const PIPE_SHOP_COLUMNS = [
  /\brealms?\s*\|+\s*stocks?/,
  /\brealm\s+[il|]\s+stock\s+[il|]\s+(?:com|coin)\b/,
];

/** `http` spelled with something between the letters, and `hxxp`. */
const MASKED_SCHEME = [
  /\bhxxps?:/,
  /\bh[\s._*|·•-]{1,12}t(?:[\s._*|·•-]{0,12}t)?[\s._*|·•-]{0,12}p[\s._*|·•-]{0,12}s?[\s._*|·•-]{0,12}[:/]/,
];

const SHORTENERS =
  /\btinyurl\b|\bbit\s*[._-]*ly\b|\bis\.gd\b|\bclck\.ru\b|\btiny\.(?:cc|one)\b|\blnk\.bio\b|\blinktr\b/;

/** Where the conversation is being moved to, which is never in the game. */
const OFF_GAME_PLATFORMS = /\bt\.me\b|\btelegram\b|\bkick\s*\.\s*com\b/;

/**
 * An address written so that neither a person nor a word list reads it as one.
 *
 * Every one of these came from a line seen in the wild: `r.e.a.l.m.s`,
 * `realm i stock i com`, `.c()m`, `dot com` spelled out next to a price.
 *
 * `oryxsp!` was here too and is not any more: the shop is in `SHOP_BRANDS`, and
 * the compacted text this scanner already builds drops the `!` on its own. One
 * name in two places is one place to forget when it changes.
 */
const OBFUSCATED_ADDRESS: readonly RegExp[] = [
  /(?:[a-z]\.){6,}[a-z]?/,
  /[a-z]{3,}![a-z0-9]{1,4}\.[a-z]{2,}/,
  /\.c\s*\(\s*\)\s*m|\)\(\)\s*\.\s*c/,
  /\brealm\s+[il|]\s+stock\s+[il|]\s+(?:com|coin)\b/,
];

/** `dot com` in words only counts next to something being sold. */
const SPELLED_DOMAIN = /d\s*[o0.]+\s*t\s+c\s*[o0.]+\s*m|\[\s*dot\s*\]\s*com/;
const COMMERCE_CONTEXT = /\b(?:buy|sell|usd|keys|deca|cheap|stock|coins?|realm|shop)\b|[$€£]/;

/** Lines drawn out of punctuation, which carry no message at all. */
const ASCII_BANNER = /={10,}|[-_=|]{14,}|(?:\*\s*){14,}/;

/** What a bot is selling when it signs off with a number. */
const BOT_TAIL_HINTS =
  /fame|deca|key|vault|shop|stock|coin|lottery|season|nexus|multitool|oryx|realm|white\s*bag|enchant|bulk|service|client|cheap|lean|\bssn\b|gift\s*card/;

/** Below this a repeated character is emphasis, above it it is a flood. */
const FLOOD_RUN = 28;
const FLOOD_MIN_LENGTH = 48;

/** A bot tail is three digits on the end of a line no person would type. */
const BOT_TAIL_MIN_LENGTH = 50;

/**
 * Every signal, in the order they are tried.
 *
 * Cheapest and most specific first, so the common case — an ordinary message
 * that matches nothing — spends as little as possible, and so a message that
 * does match is reported as the most precise thing it is.
 */
export const SPAM_SIGNALS: readonly SpamSignal[] = [
  {
    // First, because a named shop is the most precise thing a message can be:
    // `hxxps://realmstock.com` is a masked scheme and a link and an address, and
    // none of those three says as much as the name does.
    id: 'shop-domain',
    category: SpamCategory.Advertising,
    matches: (text) =>
      SHOP_BRANDS.some((brand) => text.compact.includes(brand)) ||
      SHOP_DOMAINS.some((domain) => domain.test(text.compact)) ||
      SHOP_ADDRESSES.some((address) => address.test(text.flat)),
  },
  {
    id: 'shop-word',
    category: SpamCategory.Advertising,
    matches: (text) => SHOP_WORDS.some((word) => text.compact.includes(word)),
  },
  {
    id: 'payment-method',
    category: SpamCategory.Advertising,
    matches: (text) => PAYMENT_METHODS.test(text.flat),
  },
  {
    id: 'shop-phrase',
    category: SpamCategory.Advertising,
    matches: (text) => SHOP_PHRASES.some((phrase) => phrase.test(text.flat)),
  },
  {
    id: 'shop-columns',
    category: SpamCategory.Advertising,
    matches: (text) => {
      if (PIPE_SHOP_COLUMNS.some((columns) => columns.test(text.flat))) return true;
      // Three bars is a layout rather than a turn of phrase — but on its own it
      // is also a hand-drawn table of nothing, so it has to be selling.
      return countOf(text.flat, '|') >= 3 && PIPE_SHOP_HINTS.test(text.flat);
    },
  },
  {
    id: 'masked-scheme',
    category: SpamCategory.Link,
    // Against `lower` rather than `flat`: the runs of spaces are the disguise,
    // and collapsing them is what the sender is hoping the reader does.
    matches: (text) => MASKED_SCHEME.some((scheme) => scheme.test(text.lower)),
  },
  {
    id: 'link-shortener',
    category: SpamCategory.Link,
    matches: (text) => SHORTENERS.test(text.flat),
  },
  {
    id: 'off-game-platform',
    category: SpamCategory.Link,
    matches: (text) => OFF_GAME_PLATFORMS.test(text.flat) || text.compact.includes('telegram'),
  },
  {
    id: 'obfuscated-address',
    category: SpamCategory.Link,
    matches: (text) => {
      if (OBFUSCATED_ADDRESS.some((address) => address.test(text.flat))) return true;
      return SPELLED_DOMAIN.test(text.flat) && COMMERCE_CONTEXT.test(text.flat);
    },
  },
  {
    id: 'trade-call',
    category: SpamCategory.Trading,
    matches: (text) =>
      text.loose.includes(' wts ') ||
      text.loose.includes(' wtb ') ||
      text.loose.includes(' wtt ') ||
      text.loose.includes(' wta '),
  },
  {
    id: 'ascii-banner',
    category: SpamCategory.Flood,
    matches: (text) => ASCII_BANNER.test(text.raw),
  },
  {
    id: 'repeated-character',
    category: SpamCategory.Flood,
    // Against `raw`, and this is the one signal that has to be: a flood of two
    // hundred zero-width spaces is exactly what the folding removes.
    matches: (text) => hasLongRun(text.raw),
  },
  {
    id: 'bot-tail',
    category: SpamCategory.Flood,
    matches: (text) => {
      if (text.raw.length < BOT_TAIL_MIN_LENGTH) return false;
      if (!/\s\d{3}$/.test(text.raw)) return false;
      if (BOT_TAIL_HINTS.test(text.lower)) return true;
      return countOf(text.flat, '|') >= 2 || countOf(text.raw, '=') >= 8;
    },
  },
];

/**
 * The first signal that recognises a message, out of the enabled categories.
 *
 * @returns the signal, or `undefined` when the message is worth showing.
 */
export function firstMatchingSignal(
  text: ScannedText,
  categories: ReadonlySet<SpamCategory>,
): SpamSignal | undefined {
  for (const signal of SPAM_SIGNALS) {
    if (!categories.has(signal.category)) continue;
    if (signal.matches(text)) return signal;
  }
  return undefined;
}

function countOf(text: string, character: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === character) count++;
  }
  return count;
}

/** Whether one character repeats for long enough to be a flood on its own. */
function hasLongRun(text: string): boolean {
  if (text.length < FLOOD_MIN_LENGTH) return false;
  let run = 1;
  for (let index = 1; index < text.length; index++) {
    const code = text.charCodeAt(index);
    // Whitespace is excluded: a message padded out with spaces is being
    // positioned on screen, which the banner signal is the one to judge.
    const repeats = code === text.charCodeAt(index - 1) && code > 32;
    run = repeats ? run + 1 : 1;
    if (run >= FLOOD_RUN) return true;
  }
  return false;
}
