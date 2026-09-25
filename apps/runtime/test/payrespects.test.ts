import {
  MutablePacket,
  SendPriority,
  type SendOptions,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket, type FieldValue } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it } from 'vitest';

import {
  LATE_LIMIT_MS,
  MAX_PAUSE_MS,
  MIN_PAUSE_MS,
  TRIBUTES,
  createPayRespectsPlugin,
} from '../src/features/payrespects/payRespectsPlugin.js';
import { PLAYER_DEATH_KIND, deadPlayerName } from '../src/features/payrespects/playerDeath.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { frameOf, testLogger } from './fakes.js';

const registry = createBundledRegistry();
const NOTIFICATION_ID = registry.idOf('NOTIFICATION')!;

/** The popup a dungeon portal opening is announced with: same shape, other kind. */
const PORTAL_OPENED_KIND = 8;

/** The flags byte after the kind. Nothing reads it; the server sends 0 here. */
const NO_FLAGS = 0;

/** The dead character's class, drawn in the popup. A Wizard. */
const WIZARD = 0x030e;

/**
 * A notification as the server writes one: kind, flags, message behind a
 * sixteen-bit length, and the picture.
 */
function notificationFrame(kind: number, message: string, picture = WIZARD): Buffer {
  const text = Buffer.from(message, 'utf8');
  const body = Buffer.alloc(2 + 2 + text.length + 4);
  body.writeUInt8(kind, 0);
  body.writeUInt8(NO_FLAGS, 1);
  body.writeInt16BE(text.length, 2);
  text.copy(body, 4);
  body.writeInt32BE(picture, 4 + text.length);
  return frameOf(NOTIFICATION_ID, body);
}

/**
 * The envelope a death is announced in, written the way the server writes
 * every envelope: as a template, with a comma after the last token. Seen on
 * the wire and in a running client — `{"k":"s.teleport_cooldown","t":{"amount":"3",}}`,
 * `{"k":"s.unknown_c","t":{"command":"/afk",}}` — and not JSON, which is the
 * whole point of writing it out by hand here. Only `player` is read; the key
 * and the other tokens are there so the message looks like the real thing.
 */
function deathMessage(player: string): string {
  return `{"k":"s.death","t":{"player":"${player}","level":"20","enemy":"Oryx the Mad God 3",}}`;
}

const deathFrame = (player: string): Buffer =>
  notificationFrame(PLAYER_DEATH_KIND, deathMessage(player));

describe('reading a death notification', () => {
  it('names the player who died, from the envelope as the server writes it', () => {
    expect(() => JSON.parse(deathMessage('Hero')) as unknown).toThrow(SyntaxError);
    expect(deadPlayerName(deathFrame('Hero'))).toBe('Hero');
  });

  it('names the player from strict JSON too, should the server ever write it', () => {
    const strict = JSON.stringify({ k: 's.death', t: { enemy: 'Oryx', player: 'Hero' } });
    expect(deadPlayerName(notificationFrame(PLAYER_DEATH_KIND, strict))).toBe('Hero');
  });

  it('reads a name the way the game writes a player name — up to the comma', () => {
    expect(deadPlayerName(deathFrame('Ally,9a16'))).toBe('Ally');
  });

  it('reads a message in any alphabet, since the length counts bytes', () => {
    expect(deadPlayerName(deathFrame('Воин'))).toBe('Воин');
  });

  it('ignores every other kind of notification, even one of the same shape', () => {
    const portal = notificationFrame(PORTAL_OPENED_KIND, deathMessage('Hero'));
    expect(deadPlayerName(portal)).toBeUndefined();
  });

  it('names nobody when the body is shorter than it says', () => {
    const whole = deathFrame('Hero');
    // Cut inside the message: the length still claims all of it.
    expect(deadPlayerName(whole.subarray(0, whole.length - 12))).toBeUndefined();
    // Nothing after the kind and the flags at all.
    expect(deadPlayerName(frameOf(NOTIFICATION_ID, Buffer.from([PLAYER_DEATH_KIND, 0])))).toBe(
      undefined,
    );
    // Nothing after the kind.
    expect(deadPlayerName(frameOf(NOTIFICATION_ID, Buffer.from([PLAYER_DEATH_KIND])))).toBe(
      undefined,
    );
    // No body at all.
    expect(deadPlayerName(frameOf(NOTIFICATION_ID))).toBeUndefined();
  });

  it('names nobody when the length is negative', () => {
    const body = Buffer.from([PLAYER_DEATH_KIND, 0, 0xff, 0xff]);
    expect(deadPlayerName(frameOf(NOTIFICATION_ID, body))).toBeUndefined();
  });

  it('names nobody when the message carries no player token it can read', () => {
    const death = (message: string): string | undefined =>
      deadPlayerName(notificationFrame(PLAYER_DEATH_KIND, message));

    expect(death('Hero died at level 20, killed by Oryx')).toBeUndefined();
    expect(death('')).toBeUndefined();
    expect(death('{"k":"s.death","t":{}}')).toBeUndefined();
    expect(death('{"k":"s.death","t":{"enemy":"Oryx",}}')).toBeUndefined();
    expect(death('{"k":"s.death","t":{"player":20,}}')).toBeUndefined();
    expect(death('{"k":"s.death","t":{"player":"  ",}}')).toBeUndefined();
    expect(death('{"k":"s.death","t":{"player":",9a16",}}')).toBeUndefined();
    // A name is letters: a value with an escape in it is not one, and where it
    // would end is not something to guess.
    expect(death('{"k":"s.death","t":{"player":"He\\"ro",}}')).toBeUndefined();
    // The value never ends.
    expect(death('{"k":"s.death","t":{"player":"Hero')).toBeUndefined();
  });
});

describe('the tributes', () => {
  it('are all something the chat box would send as chat', () => {
    for (const tribute of TRIBUTES) {
      expect(tribute.trim()).not.toBe('');
      expect(tribute.startsWith('/')).toBe(false);
    }
  });
});

describe('the pay-respects plugin', () => {
  const SELF = 'Brownie';
  /** Far enough apart that no test's cooldown covers the next death. */
  const LONG_AFTER_MS = 200_000;

  interface Said {
    readonly packetName: string;
    readonly text: string;
    readonly options: SendOptions | undefined;
  }

  interface Harness {
    readonly host: PluginHost;
    readonly said: Said[];
    /** Moves the clock on. */
    advance: (ms: number) => void;
    /** A tick, which is what lets a waiting tribute go. */
    tick: () => void;
    death: (player: string) => void;
    notification: (frame: Buffer) => void;
    mapinfo: () => void;
    setCooldownSeconds: (seconds: number) => void;
  }

  /**
   * @param randoms What `random` returns, in turn, repeating the last one. The
   *   plugin draws one for the pause and one for the line, in that order.
   */
  function harness(randoms: readonly number[] = [0]): Harness {
    const world = { gameTimeMs: 100_000 };
    const said: Said[] = [];
    let draw = 0;
    const random = (): number => randoms[Math.min(draw++, randoms.length - 1)] ?? 0;

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
    host.load(createPayRespectsPlugin({ random }));
    host.setEnabled('pay-respects', true);

    const built = (name: string, fields: Record<string, FieldValue>): MutablePacket => {
      const packet = createPacket(registry, name);
      Object.assign(packet.fields, fields);
      return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
    };
    const notification = (frame: Buffer): void => {
      host.dispatchPacket(new MutablePacket(decodeFrame(registry, frame)), session);
    };

    return {
      host,
      said,
      advance: (ms): void => {
        world.gameTimeMs += ms;
      },
      tick: (): void => {
        host.dispatchPacket(
          built('NEWTICK', {
            tickId: 0,
            tickTime: 200,
            serverRealTimeMs: 0,
            serverLastRttMs: 0,
            statuses: [],
          }),
          session,
        );
      },
      death: (player): void => {
        notification(deathFrame(player));
      },
      notification,
      mapinfo: (): void => {
        host.dispatchPacket(
          built('MAPINFO', {
            width: 1,
            height: 1,
            name: 'Realm of the Mad God',
            displayName: 'Realm of the Mad God',
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
          }),
          session,
        );
      },
      setCooldownSeconds: (seconds): void => {
        const settings = host.settingsOf('pay-respects');
        if (settings === undefined) throw new Error('the plugin declared no settings');
        expect(settings.apply('cooldownSeconds', seconds)).toBe(true);
      },
    };
  }

  /** Lets the longest pause run out, and ticks. */
  const afterThePause = (h: Harness): void => {
    h.advance(MAX_PAUSE_MS);
    h.tick();
  };

  it('says one tribute in chat for another player', () => {
    const h = harness();
    h.death('Hero');
    afterThePause(h);

    expect(h.said).toHaveLength(1);
    expect(h.said[0]?.packetName).toBe('PLAYERTEXT');
    expect(TRIBUTES).toContain(h.said[0]?.text);
  });

  it('waits out its pause before saying it', () => {
    // The pause is drawn first: halfway between the shortest and the longest.
    const h = harness([0.5]);
    const pauseMs = MIN_PAUSE_MS + 0.5 * (MAX_PAUSE_MS - MIN_PAUSE_MS);
    h.death('Hero');

    h.tick();
    h.advance(pauseMs - 1);
    h.tick();
    expect(h.said).toHaveLength(0);

    h.advance(1);
    h.tick();
    expect(h.said).toHaveLength(1);
  });

  it('picks the line at random from the list', () => {
    // One draw for the pause, then one for the line.
    const first = harness([0, 0]);
    first.death('Hero');
    afterThePause(first);

    const last = harness([0, 0.999]);
    last.death('Hero');
    afterThePause(last);

    expect(first.said[0]?.text).toBe(TRIBUTES[0]);
    expect(last.said[0]?.text).toBe(TRIBUTES.at(-1));
  });

  it('never says it more than once for one death', () => {
    const h = harness();
    h.death('Hero');
    for (let i = 0; i < 20; i += 1) afterThePause(h);

    expect(h.said).toHaveLength(1);
  });

  it('answers a burst of deaths with one tribute', () => {
    const h = harness();
    h.death('Hero');
    h.advance(200);
    h.death('Sidekick');
    h.death('Bystander');
    afterThePause(h);

    expect(h.said).toHaveLength(1);
  });

  it('does not put a waiting tribute off for the deaths that land behind it', () => {
    // Every pause the shortest, so the first death's tribute is due at 1 s.
    const h = harness([0]);
    h.death('Hero');
    h.advance(MIN_PAUSE_MS - 100);
    h.death('Sidekick');
    h.advance(100);
    h.tick();

    // A stream of deaths must not keep pushing the one tribute back.
    expect(h.said).toHaveLength(1);
  });

  it('stays quiet about its own death, however the name is spelled', () => {
    const h = harness();
    h.death(SELF);
    h.death(SELF.toUpperCase());
    h.death(`${SELF},9a16`);
    afterThePause(h);

    expect(h.said).toHaveLength(0);
  });

  it('stays quiet about notifications that are not a death', () => {
    const h = harness();
    h.notification(notificationFrame(PORTAL_OPENED_KIND, deathMessage('Hero')));
    h.notification(notificationFrame(PLAYER_DEATH_KIND, 'not the envelope'));
    afterThePause(h);

    expect(h.said).toHaveLength(0);
  });

  it('stays quiet for the cooldown after a tribute, then speaks again', () => {
    const h = harness();
    h.setCooldownSeconds(30);
    h.death('Hero');
    afterThePause(h);

    h.advance(20_000);
    h.death('Sidekick');
    afterThePause(h);
    expect(h.said).toHaveLength(1);

    h.advance(30_000);
    h.death('Bystander');
    afterThePause(h);
    expect(h.said).toHaveLength(2);
  });

  it('pays respects to every death apart when the cooldown is off', () => {
    const h = harness();
    h.setCooldownSeconds(0);
    h.death('Hero');
    afterThePause(h);
    h.death('Sidekick');
    afterThePause(h);

    expect(h.said).toHaveLength(2);
  });

  it('forgets a tribute that was waiting when the map changed', () => {
    const h = harness();
    h.death('Hero');
    h.mapinfo();
    afterThePause(h);

    expect(h.said).toHaveLength(0);
  });

  it('drops a tribute that was waiting while the plugin was off', () => {
    const h = harness();
    h.death('Hero');
    h.host.setEnabled('pay-respects', false);
    h.advance(MAX_PAUSE_MS + LATE_LIMIT_MS + 1);
    h.tick();
    h.host.setEnabled('pay-respects', true);
    h.tick();

    expect(h.said).toHaveLength(0);

    // And the plugin is not left stuck on it.
    h.advance(LONG_AFTER_MS);
    h.death('Sidekick');
    afterThePause(h);
    expect(h.said).toHaveLength(1);
  });

  it('asks the queue to send it behind everything else, once, and not late', () => {
    const h = harness();
    h.death('Hero');
    afterThePause(h);

    const options = h.said[0]?.options;
    expect(options?.priority).toBe(SendPriority.Background);
    expect(options?.key).toMatch(/^pay-respects:/);
    expect(options?.expiresInMs).toBe(LATE_LIMIT_MS);
  });

  it('says nothing while switched off', () => {
    const h = harness();
    h.host.setEnabled('pay-respects', false);
    h.death('Hero');
    afterThePause(h);

    expect(h.said).toHaveLength(0);
  });
});
