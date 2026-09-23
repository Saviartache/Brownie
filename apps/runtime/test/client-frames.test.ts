import type { BornShot, ClientFrameMessage } from '@brownie/ipc';
import type { SessionView } from '@brownie/plugin-api';
import { describe, expect, it } from 'vitest';
import { CLIENT_CLOCK_WINDOW_MS, ClientClock } from '../src/native/ClientClock.js';
import {
  CLIENT_POSITION_FRESH_MS,
  ClientFrames,
  MAX_POSITION_LEAD_MS,
} from '../src/native/ClientFrames.js';
import { WorldState } from '../src/state/WorldState.js';
import { projectileDefinition } from './fakes.js';

describe('ClientClock', () => {
  it('knows nothing until a frame has arrived', () => {
    const clock = new ClientClock();
    expect(clock.known).toBe(false);
    expect(clock.toSession(1000)).toBeUndefined();
  });

  it('puts a client moment on the session clock by the quickest arrival', () => {
    const clock = new ClientClock();
    // Stamped at 50 000 on the client, read at 120 on the session: 49 880 apart,
    // plus however long the frame took.
    clock.observe(120, 50_000);
    expect(clock.toSession(50_000)).toBe(120);

    // A frame that got here quicker says the clocks are closer than that.
    clock.observe(130, 50_016);
    expect(clock.toSession(50_000)).toBe(114);

    // And one held up in a busy event loop says nothing new.
    clock.observe(200, 50_032);
    expect(clock.toSession(50_000)).toBe(114);
  });

  it('follows a session clock that was nudged, within two windows', () => {
    const clock = new ClientClock();
    clock.observe(100, 10_000);
    // Wall time stepped forward by forty milliseconds: every arrival from now on
    // reads forty later, and the old minimum is kept only while its window is.
    let at = 100;
    for (let frame = 1; frame <= 200; frame += 1) {
      at += 16;
      clock.observe(at + 40, 10_000 + frame * 16);
    }
    expect(at - 100).toBeGreaterThan(2 * CLIENT_CLOCK_WINDOW_MS);
    expect(clock.toSession(10_000)).toBe(140);
  });

  it('drops a stamp that is not a number', () => {
    const clock = new ClientClock();
    clock.observe(100, Number.NaN);
    expect(clock.known).toBe(false);
  });

  it('forgets everything when told to', () => {
    const clock = new ClientClock();
    clock.observe(100, 10_000);
    clock.reset();
    expect(clock.toSession(10_000)).toBeUndefined();
  });
});

describe('ClientFrames', () => {
  /** A connected session whose clock the test moves by hand. */
  function rig() {
    const time = { now: 10_000 };
    const world = new WorldState({ now: () => time.now });
    world.markConnected();
    const session = { id: 's1' } as unknown as SessionView;
    const frames = new ClientFrames();
    frames.attach(session, world);
    return { time, world, session, frames };
  }

  function frame(over: Partial<ClientFrameMessage> = {}): ClientFrameMessage {
    return {
      kind: 'clientFrame',
      player: undefined,
      frameTimeMs: undefined,
      scanned: false,
      born: [],
      gone: [],
      ...over,
    };
  }

  const BORN: BornShot = {
    ownerId: 7,
    bulletId: 3,
    ageMs: 10,
    x: 5,
    y: 5,
    angle: Math.PI / 2,
    speedMultiplier: 1,
    lifetimeMs: 1000,
    halfTiles: 0.25,
  };

  it('has nothing to say about a player it has not heard about', () => {
    const { frames, session } = rig();
    expect(frames.playerAt(session)).toBeUndefined();
  });

  it('says where the client has the player, and carries it along its own walk', () => {
    const { time, frames, session } = rig();
    // Two frames sixteen milliseconds apart on the client's clock, the player a
    // tenth of a tile further east on the second: six and a quarter tiles a
    // second.
    frames.accept(frame({ player: { x: 10, y: 10 }, frameTimeMs: 90_000 }));
    time.now += 16;
    frames.accept(frame({ player: { x: 10.1, y: 10 }, frameTimeMs: 90_016 }));
    expect(frames.playerAt(session)?.x).toBeCloseTo(10.1);

    // Twenty milliseconds on, it has walked another eighth of a tile.
    time.now += 20;
    expect(frames.playerAt(session)?.x).toBeCloseTo(10.1 + 6.25 * 0.02);

    // And no further than the lead allows, however long ago the frame was.
    time.now += 150;
    const lead = (MAX_POSITION_LEAD_MS / 1000) * 6.25;
    expect(frames.playerAt(session)?.x).toBeCloseTo(10.1 + lead);
  });

  it('lets go of a reading the module has stopped refreshing', () => {
    const { time, frames, session } = rig();
    frames.accept(frame({ player: { x: 10, y: 10 }, frameTimeMs: 90_000 }));
    time.now += CLIENT_POSITION_FRESH_MS + 1;
    expect(frames.playerAt(session)).toBeUndefined();
  });

  it('does not carry a teleport forward as a walk', () => {
    const { time, frames, session } = rig();
    frames.accept(frame({ player: { x: 10, y: 10 }, frameTimeMs: 90_000 }));
    time.now += 16;
    frames.accept(frame({ player: { x: 40, y: 10 }, frameTimeMs: 90_016 }));
    time.now += 20;
    expect(frames.playerAt(session)?.x).toBeCloseTo(40);
  });

  it('answers only about the session the frames were for', () => {
    const { frames, session } = rig();
    frames.accept(frame({ player: { x: 10, y: 10 }, frameTimeMs: 90_000 }));
    expect(frames.playerAt({ id: 's2' } as unknown as SessionView)).toBeUndefined();

    frames.detach(session);
    expect(frames.playerAt(session)).toBeUndefined();
  });

  it('places nothing on a session clock that has not started', () => {
    const world = new WorldState({ now: () => 10_000 });
    const session = { id: 's1' } as unknown as SessionView;
    const frames = new ClientFrames();
    frames.attach(session, world);
    frames.accept(frame({ player: { x: 10, y: 10 }, frameTimeMs: 90_000 }));
    expect(frames.playerAt(session)).toBeUndefined();
  });

  it('starts over when the module on the other end does', () => {
    const { frames, session } = rig();
    frames.accept(frame({ player: { x: 10, y: 10 }, frameTimeMs: 90_000 }));
    frames.reset();
    expect(frames.playerAt(session)).toBeUndefined();
  });

  describe('the shots', () => {
    function tracked() {
      const setup = rig();
      setup.world.projectileStore.add(projectileDefinition({ speed: 100 }), {
        ownerId: 7,
        bulletId: 3,
        bulletType: 0,
        x: 5,
        y: 5,
        angle: 0,
        speedMultiplier: 1,
        lifetimeMultiplier: 1,
        firedAtMs: 0,
      });
      return setup;
    }

    // The packet passed through at session time nought; the client read it and
    // started the shot a few frames later, and flew it north, not east.
    it('flies a shot from when and how the client started it', () => {
      const { world, frames } = tracked();
      // Arrived the moment it was stamped, at session time nought — so the two
      // clocks are ninety thousand apart.
      frames.accept(frame({ frameTimeMs: 90_000, scanned: true, born: [BORN] }));

      const [shot] = [...world.projectiles()];
      // Started ten milliseconds before the frame.
      expect(shot?.firedAtMs).toBe(-10);
      expect(shot?.collisionHalfTiles).toBe(0.25);
      const at = shot?.positionAt(-10 + 500);
      expect(at?.x).toBeCloseTo(5);
      expect(at?.y).toBeCloseTo(10);
      expect(world.shots.confirmed).toBe(1);
    });

    it('forgets a shot the client destroyed, whatever it passes through', () => {
      const { world, frames } = tracked();
      frames.accept(
        frame({ frameTimeMs: 90_000, scanned: true, gone: [{ ownerId: 7, bulletId: 3 }] }),
      );
      expect(world.projectileStore.size).toBe(0);
      expect(world.shots.ended).toBe(1);
    });

    it('changes nothing when the frame was not scanned', () => {
      const { world, frames } = tracked();
      frames.accept(frame({ frameTimeMs: 90_000, scanned: false }));
      expect(world.projectileStore.size).toBe(1);
      expect([...world.projectiles()][0]?.firedAtMs).toBe(0);
    });

    it('counts only what it found to confirm or forget', () => {
      const { world, frames } = tracked();
      frames.accept(
        frame({
          frameTimeMs: 90_000,
          scanned: true,
          born: [{ ...BORN, ownerId: 8 }],
          gone: [{ ownerId: 8, bulletId: 3 }],
        }),
      );
      expect(world.shots.confirmed).toBe(0);
      expect(world.shots.ended).toBe(0);
      expect(world.projectileStore.size).toBe(1);
    });
  });
});
