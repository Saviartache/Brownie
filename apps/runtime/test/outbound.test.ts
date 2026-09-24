import { MutablePacket, SendOutcome, SendPriority, wasSent } from '@brownie/plugin-api';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { describe, expect, it } from 'vitest';
import { laneOf } from '../src/outbound/actionLanes.js';
import { ServerActionQueue } from '../src/outbound/ServerActionQueue.js';
import { RecordingSink, testLogger } from './fakes.js';

/**
 * A clock and a timer wheel the test drives by hand.
 *
 * The queue is entirely about *when*, so a test that waited on real timers
 * would be a test that either takes ten seconds or passes on a fast machine and
 * fails on a slow one.
 */
class TestClock {
  #nowMs = 1_000_000;
  #timers: { atMs: number; fn: () => void; cancelled: boolean }[] = [];

  get nowMs(): number {
    return this.#nowMs;
  }

  readonly now = (): number => this.#nowMs;

  readonly schedule = (fn: () => void, ms: number): (() => void) => {
    const timer = { atMs: this.#nowMs + ms, fn, cancelled: false };
    this.#timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  /** Moves time on, firing whatever falls due — including timers set while firing. */
  advance(ms: number): void {
    const untilMs = this.#nowMs + ms;
    for (;;) {
      const due = this.#timers
        .filter((timer) => !timer.cancelled && timer.atMs <= untilMs)
        .sort((a, b) => a.atMs - b.atMs)[0];
      if (due === undefined) break;
      due.cancelled = true;
      this.#nowMs = Math.max(this.#nowMs, due.atMs);
      due.fn();
    }
    this.#nowMs = untilMs;
    this.#timers = this.#timers.filter((timer) => !timer.cancelled);
  }
}

interface Harness {
  queue: ServerActionQueue;
  clock: TestClock;
  /** Every packet that reached the wire, in order. */
  sent: { name: string; fields: Record<string, unknown> }[];
  /** Outcomes by the label the test submitted under. */
  outcomes: Map<string, SendOutcome>;
  /** Labels whose packet actually left, in the order they left. */
  order: string[];
  sink: RecordingSink;
  /** Makes the next {@link Harness.sent} fail to encode. */
  breakNextSend: () => void;
  submit: (
    label: string,
    packetName: string,
    options?: Parameters<ServerActionQueue['submit']>[2],
    fields?: Record<string, unknown>,
  ) => boolean;
  /** One of the client's own packets has just gone to the server. `MOVE` unless named. */
  speak: (packetName?: string) => void;
  /**
   * Moves time on while the client keeps talking, the way it does in play: it
   * answers every server tick, so something of its own passes every
   * `everyMs`.
   */
  run: (ms: number, everyMs?: number) => void;
}

function harness(tuning?: Parameters<typeof makeQueue>[0]): Harness {
  return makeQueue(tuning);
}

function makeQueue(tuning?: ConstructorParameters<typeof ServerActionQueue>[0]['tuning']): Harness {
  const clock = new TestClock();
  const sent: { name: string; fields: Record<string, unknown> }[] = [];
  const outcomes = new Map<string, SendOutcome>();
  const order: string[] = [];
  const sink = new RecordingSink();
  let broken = false;

  const queue = new ServerActionQueue({
    send: (name, fields) => {
      if (broken) {
        broken = false;
        return false;
      }
      sent.push({ name, fields: { ...fields } });
      return true;
    },
    // The real one reads the world's clock and the player's position; this one
    // only has to prove it ran at the last instant rather than the first.
    refresh: (fields, which) => {
      for (const field of which) fields[field] = clock.nowMs;
    },
    log: testLogger(sink),
    now: clock.now,
    schedule: clock.schedule,
    ...(tuning === undefined ? {} : { tuning }),
  });

  const speak = (packetName = 'MOVE'): void => {
    queue.clientPacketPassed(packetOf(packetName));
  };

  return {
    queue,
    clock,
    sent,
    outcomes,
    order,
    sink,
    breakNextSend: () => {
      broken = true;
    },
    submit: (label, packetName, options = {}, fields = {}) =>
      queue.submit(packetName, fields, {
        ...options,
        onSent: () => {
          order.push(label);
          options.onSent?.();
        },
        onOutcome: (outcome) => {
          outcomes.set(label, outcome);
          options.onOutcome?.(outcome);
        },
      }),
    speak,
    run: (ms, everyMs = 100) => {
      for (let elapsed = everyMs; elapsed <= ms; elapsed += everyMs) {
        clock.advance(everyMs);
        speak();
      }
    },
  };
}

const registry = createBundledRegistry();

/**
 * A packet as the pipeline would hand it to the queue — through the real
 * encoder and decoder, so a field the queue reads is a field that survives the
 * wire rather than one a literal happened to spell right.
 */
function packetOf(name: string, fields: Record<string, unknown> = {}): MutablePacket {
  const built = createPacket(registry, name);
  for (const [key, value] of Object.entries(fields)) {
    // The encoder validates what the schema says each field holds, so a wrong
    // value fails here rather than being quietly accepted by this cast.
    built.fields[key] = value as never;
  }
  return new MutablePacket(decodeFrame(registry, encodePacket(registry, built)));
}

/** What the server says when it refuses. `errorId` is always 0 in the wild. */
function failure(errorMessage = ''): MutablePacket {
  return packetOf('FAILURE', { errorId: 0, errorMessage });
}

describe('the lane table', () => {
  it('paces the packets a server was measured to count, and nothing else', () => {
    expect(laneOf('INVENTORYSWAP')?.lane).toBe('item');
    expect(laneOf('USEITEM')?.lane).toBe('item');
    expect(laneOf('USEPORTAL')?.lane).toBe('travel');
    // The ones that must never wait: an answer the server is already expecting,
    // somebody's life, and the player walking.
    expect(laneOf('ESCAPE')).toBeUndefined();
    expect(laneOf('AOEACK')).toBeUndefined();
    expect(laneOf('PLAYERHIT')).toBeUndefined();
    expect(laneOf('MOVE')).toBeUndefined();
  });

  it('asks a move for far more room than a use', () => {
    const move = laneOf('INVENTORYSWAP');
    const use = laneOf('USEITEM');
    expect(move).toBeDefined();
    expect(use).toBeDefined();
    expect(move?.spacingMs).toBeGreaterThan(use?.spacingMs ?? 0);
  });
});

describe('the outbound queue', () => {
  it('sends an unpaced packet during the call, and says so', () => {
    const h = harness();
    expect(h.submit('escape', 'ESCAPE')).toBe(true);
    expect(h.sent.map((packet) => packet.name)).toEqual(['ESCAPE']);
    expect(h.outcomes.get('escape')).toBe(SendOutcome.Sent);
    expect(h.queue.depth).toBe(0);
  });

  describe('where in the stream a paced packet lands', () => {
    it('holds it until the client has put one of its own on the wire, and follows that', () => {
      // The game client sends every packet behind the shot acknowledgements it
      // owes. Anything of ours that goes out at another moment can overtake
      // acknowledgements the client already owes — an order the real client
      // cannot produce.
      const h = harness();
      expect(h.submit('loot', 'INVENTORYSWAP')).toBe(false);
      h.clock.advance(1000);
      expect(h.sent).toHaveLength(0);

      h.speak();
      expect(h.order).toEqual(['loot']);
    });

    it('never follows a shot acknowledgement, only the message it was flushed ahead of', () => {
      // The acknowledgements come immediately before the packet whose sending
      // flushed them, so after one of them that packet is still to come.
      const h = harness();
      h.submit('loot', 'INVENTORYSWAP');
      h.speak('SHOOTACKCOUNTER');
      expect(h.sent).toHaveLength(0);

      h.speak('MOVE');
      expect(h.order).toEqual(['loot']);
    });

    it('lets a waiting packet expire rather than send it from a timer', () => {
      // A client that has gone quiet — a map loading, a stalled frame — is not
      // one to slip a packet in behind.
      const h = harness();
      h.submit('loot', 'INVENTORYSWAP', { expiresInMs: 500 });
      h.clock.advance(600);
      expect(h.outcomes.get('loot')).toBe(SendOutcome.Expired);
      expect(h.sent).toHaveLength(0);
    });

    it('still follows a client packet a stage withheld, which cost the server nothing', () => {
      const h = harness();
      h.submit('loot', 'INVENTORYSWAP');
      const withheld = swapPacket();
      withheld.drop();
      h.queue.clientPacketPassed(withheld);
      // Not spaced behind it and not made stale by it: the server never heard
      // it. And the acknowledgements ahead of it did go out.
      expect(h.order).toEqual(['loot']);
    });
  });

  it('sends one packet of a lane when the client speaks, and holds the second', () => {
    const h = harness();
    h.submit('loot', 'INVENTORYSWAP');
    // This is the collision the whole thing exists for: a cast decided in the
    // same tick as a pickup.
    h.submit('cast', 'USEITEM');
    h.speak();
    expect(h.order).toEqual(['loot']);
    expect(h.queue.depth).toBe(1);
  });

  it('makes a cheap packet wait out the expensive one before it', () => {
    const h = harness();
    h.submit('loot', 'INVENTORYSWAP');
    h.submit('cast', 'USEITEM');
    h.speak();

    // A use asks for only 250 ms of its own; what it is waiting out is the
    // move's second.
    h.run(900);
    expect(h.order).toEqual(['loot']);
    h.run(200);
    expect(h.order).toEqual(['loot', 'cast']);
  });

  it('does not make one lane wait for another', () => {
    const h = harness();
    h.submit('loot', 'INVENTORYSWAP');
    // A portal is a different limit, if it is a limit at all — pacing it behind
    // an item move would be paying for something that was never measured.
    h.submit('portal', 'USEPORTAL');
    h.speak();
    expect(h.order).toEqual(['loot', 'portal']);
  });

  it('lets a potion past a queue full of looting, without jumping the spacing', () => {
    const h = harness();
    h.submit('loot', 'INVENTORYSWAP');
    h.speak();
    h.submit('take', 'USEITEM', { priority: SendPriority.Background });
    h.submit('drink', 'USEITEM', { priority: SendPriority.Survival });

    h.run(500);
    // Priority decides the order of the queue, never the floor under it.
    expect(h.order).toEqual(['loot']);

    h.run(600);
    expect(h.order).toEqual(['loot', 'drink']);
  });

  it('keeps the oldest first among equals', () => {
    const h = harness();
    h.submit('first', 'INVENTORYSWAP');
    h.submit('second', 'USEITEM');
    h.submit('third', 'USEITEM');
    h.run(2000);
    expect(h.order).toEqual(['first', 'second', 'third']);
  });

  it('replaces a waiting request that named the same intent', () => {
    const h = harness();
    h.submit('move', 'INVENTORYSWAP');
    h.speak();
    h.submit('older', 'USEITEM', { key: 'auto-drink:health' });
    h.submit('newer', 'USEITEM', { key: 'auto-drink:health' });

    expect(h.outcomes.get('older')).toBe(SendOutcome.Superseded);
    expect(h.queue.depth).toBe(1);
    h.run(1100);
    expect(h.order).toEqual(['move', 'newer']);
  });

  it('drops a request that waited past its deadline rather than sending it late', () => {
    const h = harness();
    h.submit('move', 'INVENTORYSWAP');
    h.speak();
    h.submit('stale', 'USEITEM', { expiresInMs: 300 });

    h.run(1100);
    expect(h.outcomes.get('stale')).toBe(SendOutcome.Expired);
    expect(h.order).toEqual(['move']);
    expect(wasSent(SendOutcome.Expired)).toBe(false);
  });

  it('fills in the fields that mean "now" when the packet leaves, not when it was asked for', () => {
    const h = harness();
    h.submit('first', 'INVENTORYSWAP');
    h.submit('second', 'INVENTORYSWAP');
    h.clock.advance(100);
    const at = h.clock.nowMs;
    h.speak();
    h.clock.advance(1000);
    h.speak();

    expect(h.sent[0]?.fields['time']).toBe(at);
    // The whole reason a queue is allowed to hold a packet: the second one
    // carries the clock of the moment it left, not the moment it was decided.
    expect(h.sent[1]?.fields['time']).toBe(at + 1000);
  });

  describe('waiting for one packet to settle', () => {
    it('holds the lane until the caller says it landed', () => {
      const h = harness();
      let landed = false;
      h.submit('move', 'INVENTORYSWAP', { confirm: () => landed, confirmWindowMs: 5000 });
      // Given a deadline it cannot reach: what is under test here is the hold,
      // and the default deadline would otherwise expire it while it waited.
      h.submit('next', 'INVENTORYSWAP', { expiresInMs: 30_000 });
      h.speak();

      // Well past the spacing, and still nothing: an unanswered move is exactly
      // what must not be followed by a second one aimed from the same picture.
      h.run(3000);
      expect(h.order).toEqual(['move']);

      landed = true;
      h.run(100);
      expect(h.outcomes.get('move')).toBe(SendOutcome.Confirmed);
      expect(h.order).toEqual(['move', 'next']);
    });

    it('gives up on it after its window and reports the silence as silence', () => {
      const h = harness();
      h.submit('move', 'INVENTORYSWAP', { confirm: () => false, confirmWindowMs: 800 });
      h.speak();
      h.clock.advance(900);
      // Not "refused": a bag somebody else emptied and a bag that was merely
      // slow both answer with nothing at all.
      expect(h.outcomes.get('move')).toBe(SendOutcome.Unconfirmed);
    });

    it('does not let a confirmation that throws wedge the lane', () => {
      const h = harness();
      h.submit('bad', 'INVENTORYSWAP', {
        confirm: () => {
          throw new Error('the caller is broken');
        },
        confirmWindowMs: 500,
      });
      h.submit('next', 'INVENTORYSWAP');
      h.speak();

      h.run(1600);
      expect(h.outcomes.get('bad')).toBe(SendOutcome.Unconfirmed);
      expect(h.order).toEqual(['bad', 'next']);
      expect(h.sink.messages().some((line) => line.includes('confirming'))).toBe(true);
    });
  });

  describe('when the server complains', () => {
    it('charges the FAILURE to what was in flight and holds every lane', () => {
      const h = harness();
      h.submit('move', 'INVENTORYSWAP', { confirm: () => false });
      h.submit('later', 'USEITEM');
      h.submit('portal', 'USEPORTAL');
      h.speak();
      expect(h.order).toEqual(['move', 'portal']);

      h.clock.advance(100);
      h.queue.observe(failure('Bad message received'));

      expect(h.outcomes.get('move')).toBe(SendOutcome.Refused);
      expect(h.queue.holding).toBe(true);

      // The lane is free again as far as spacing goes, and still quiet.
      h.run(1000);
      expect(h.order).toEqual(['move', 'portal']);

      h.run(1100);
      expect(h.order).toEqual(['move', 'portal', 'later']);
    });

    it('goes quieter each time, up to a cap', () => {
      const h = harness({ failureHoldMs: 1000, maxFailureHoldMs: 3000 });
      const complain = (): void => {
        h.queue.observe(failure());
      };

      complain();
      h.clock.advance(1001);
      expect(h.queue.holding).toBe(false);

      complain();
      complain();
      // Third in a row: 1000 * 2^2 = 4000, capped at 3000.
      h.clock.advance(2999);
      expect(h.queue.holding).toBe(true);
      h.clock.advance(2);
      expect(h.queue.holding).toBe(false);
    });

    it('goes quiet even when nothing of ours can be blamed', () => {
      const h = harness();
      // We cannot prove a complaint was not about us, and the two ways of being
      // wrong cost wildly different amounts.
      h.queue.observe(failure('nope'));
      expect(h.queue.holding).toBe(true);
      h.submit('move', 'INVENTORYSWAP');
      h.speak();
      expect(h.order).toEqual([]);
    });

    it('treats a confirmed packet as evidence the server is listening again', () => {
      const h = harness({ failureHoldMs: 1000, maxFailureHoldMs: 30_000 });
      h.queue.observe(failure());
      h.clock.advance(1100);

      let landed = false;
      h.submit('move', 'INVENTORYSWAP', { confirm: () => landed });
      h.speak();
      landed = true;
      h.clock.advance(100);
      expect(h.outcomes.get('move')).toBe(SendOutcome.Confirmed);

      // The streak is broken, so the next complaint is a first one again.
      h.queue.observe(failure());
      h.clock.advance(1100);
      expect(h.queue.holding).toBe(false);
    });
  });

  describe("the player's own hands", () => {
    it('counts their item packets against the lane', () => {
      const h = harness();
      // The floor is about the server, not about who asked — and a plugin
      // racing the player's own hands is the same collision as two plugins
      // racing.
      h.queue.clientPacketPassed(swapPacket());
      h.submit('ours', 'USEITEM');
      h.speak();
      expect(h.order).toEqual([]);

      h.clock.advance(1001);
      h.speak();
      expect(h.order).toEqual(['ours']);
    });

    it('drops the item requests that were aimed at the inventory before they changed it', () => {
      // A swap into the slot they have just filled, or a drink from the one
      // they have just emptied, names contents the server no longer has.
      const h = harness();
      h.submit('loot', 'INVENTORYSWAP');
      h.submit('portal', 'USEPORTAL');
      h.queue.clientPacketPassed(swapPacket());

      expect(h.outcomes.get('loot')).toBe(SendOutcome.Dropped);
      // Another lane's request is aimed at nothing they touched.
      expect(h.order).toEqual(['portal']);
      expect(h.queue.depth).toBe(0);
    });
  });

  it('throws away everything aimed at a map the player has left', () => {
    const h = harness();
    h.submit('move', 'INVENTORYSWAP');
    h.speak();
    h.submit('next', 'INVENTORYSWAP', { confirm: () => false });
    h.queue.observe(packetOf('MAPINFO'));

    expect(h.outcomes.get('next')).toBe(SendOutcome.Dropped);
    expect(h.queue.depth).toBe(0);
    h.run(5000);
    expect(h.order).toEqual(['move']);
  });

  it('tells a caller its packet was sent even when the map took the watch away', () => {
    const h = harness();
    // Out on the wire, waiting only to be confirmed. "Dropped" would say it
    // never left, and a caller that believed it would put its own bookkeeping
    // back by one move.
    h.submit('move', 'INVENTORYSWAP', { confirm: () => false });
    h.speak();
    h.queue.observe(packetOf('MAPINFO'));
    expect(h.outcomes.get('move')).toBe(SendOutcome.Unconfirmed);
    expect(wasSent(SendOutcome.Unconfirmed)).toBe(true);
  });

  it('refuses a send asked for from inside an outcome handler as the session closes', () => {
    const h = harness();
    let refused: SendOutcome | undefined;
    h.submit('queued', 'INVENTORYSWAP', {
      onOutcome: () => {
        // A plugin answering "that did not work" by trying something else. The
        // queue is going away, so it is told so rather than left waiting.
        h.queue.submit('INVENTORYSWAP', {}, { onOutcome: (outcome) => (refused = outcome) });
      },
    });
    h.submit('next', 'INVENTORYSWAP');
    h.queue.dispose();

    expect(refused).toBe(SendOutcome.Dropped);
    expect(h.queue.depth).toBe(0);
  });

  it('drops the least wanted request rather than growing without bound', () => {
    const h = harness({ maxQueuedPerLane: 2 });
    h.submit('sent', 'INVENTORYSWAP');
    h.speak();
    h.submit('cheap', 'USEITEM', { priority: SendPriority.Background });
    h.submit('dear', 'USEITEM', { priority: SendPriority.Survival });
    h.submit('third', 'USEITEM', { priority: SendPriority.Normal });

    expect(h.outcomes.get('cheap')).toBe(SendOutcome.Dropped);
    expect(h.queue.depth).toBe(2);
  });

  it('does not hold the lane for a packet that never reached the wire', () => {
    const h = harness();
    h.breakNextSend();
    h.submit('malformed', 'INVENTORYSWAP', { confirm: () => false });
    h.speak();
    expect(h.outcomes.get('malformed')).toBe(SendOutcome.Dropped);
    expect(h.sent).toHaveLength(0);

    // The lane is not waiting on a confirmation for something that was never
    // sent — but it *is* still spaced, because a packet we failed to build is
    // no reason to believe the server wants two in a row.
    h.submit('next', 'INVENTORYSWAP');
    h.run(1100);
    expect(h.order).toEqual(['next']);
  });

  it('sends nothing once the session has gone', () => {
    const h = harness();
    h.submit('waiting', 'INVENTORYSWAP');
    h.speak();
    h.submit('queued', 'INVENTORYSWAP');
    h.queue.dispose();

    expect(h.outcomes.get('queued')).toBe(SendOutcome.Dropped);
    h.run(10_000);
    expect(h.order).toEqual(['waiting']);

    expect(h.submit('after', 'ESCAPE')).toBe(false);
    expect(h.outcomes.get('after')).toBe(SendOutcome.Dropped);
  });
});

/** An inventory move, as the game client's own would arrive. */
function swapPacket(): MutablePacket {
  return packetOf('INVENTORYSWAP', {
    time: 1,
    position: { x: 0, y: 0 },
    slotObject1: { objectId: 100, slotId: 0, objectType: 2594 },
    slotObject2: { objectId: 1, slotId: 4, objectType: -1 },
  });
}
