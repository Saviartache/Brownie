import { MutablePacket } from '@brownie/plugin-api';
import { PacketDirection, type PacketRegistry, type PacketSchema } from '@brownie/protocol';
import { describe, expect, it } from 'vitest';

import { PacketCensus } from '../src/observe/PacketCensus.js';
import { PacketOrigin } from '../src/pipeline/PacketPipeline.js';

/** Two definitions, one each way, and nothing else. */
function registry(): PacketRegistry {
  const schemas = new Map<number, PacketSchema>([
    [1, { id: 1, name: 'MOVE', direction: PacketDirection.ClientToServer, fields: [] }],
    [2, { id: 2, name: 'UPDATE', direction: PacketDirection.ServerToClient, fields: [] }],
  ]);
  return {
    schemaById: (id: number) => schemas.get(id),
  } as unknown as PacketRegistry;
}

function packet(id: number, name: string, schema: PacketSchema | undefined): MutablePacket {
  return new MutablePacket({
    id,
    name,
    direction: schema?.direction,
    schema,
    frame: Buffer.alloc(8),
    fields: {},
    trailing: Buffer.alloc(0),
    error: undefined,
  });
}

describe('PacketCensus', () => {
  it('counts each id by the side it came from', () => {
    const census = new PacketCensus(registry());
    const stage = census.stage();
    const move = registry().schemaById(1);

    stage.handle(packet(1, 'MOVE', move), { origin: PacketOrigin.Client, sessionId: 's1' });
    stage.handle(packet(1, 'MOVE', move), { origin: PacketOrigin.Client, sessionId: 's1' });

    const report = census.report();
    expect(report.totalPackets).toBe(2);
    expect(report.ids).toHaveLength(1);
    expect(report.ids[0]).toMatchObject({ id: 1, fromClient: 2, fromServer: 0 });
  });

  it('names an id nothing defines', () => {
    const census = new PacketCensus(registry());
    census.stage().handle(packet(99, 'UNKNOWN_99', undefined), {
      origin: PacketOrigin.Server,
      sessionId: 's1',
    });

    expect(census.report().ids[0]).toMatchObject({ id: 99, undefinedId: true });
  });

  it('reports a packet arriving from the side its definition rules out', () => {
    // The open question in docs/protocol.md, and the only thing that settles
    // it: a definition says one direction, the wire shows the other.
    const census = new PacketCensus(registry());
    const move = registry().schemaById(1);
    census
      .stage()
      .handle(packet(1, 'MOVE', move), { origin: PacketOrigin.Server, sessionId: 's1' });

    expect(census.report().ids[0]?.directionConflict).toMatch(
      /defined c2s, seen 1 from the server/,
    );
  });

  it('notices a body the schema left bytes over from', () => {
    // The case the first live capture hid: an empty schema cannot fail to
    // decode, so a definition with no fields at all reported as a clean
    // success while nine bytes of every packet went undescribed.
    const census = new PacketCensus(registry());
    const empty = registry().schemaById(1);
    const packetWithTail = new MutablePacket({
      id: 1,
      name: 'MOVE',
      direction: empty?.direction,
      schema: empty,
      frame: Buffer.alloc(14),
      fields: {},
      trailing: Buffer.alloc(9),
      error: undefined,
    });
    census.stage().handle(packetWithTail, { origin: PacketOrigin.Client, sessionId: 's1' });

    expect(census.report().ids[0]?.undescribedBytes).toBe(9);
    expect(census.summary()).toContain('1 with bytes nobody describes');
  });

  it('keeps no bytes unless sampling was asked for', () => {
    const withTail = (): MutablePacket =>
      new MutablePacket({
        id: 1,
        name: 'MOVE',
        direction: PacketDirection.ClientToServer,
        schema: registry().schemaById(1),
        frame: Buffer.alloc(14),
        fields: {},
        trailing: Buffer.from([0xde, 0xad]),
        error: undefined,
      });

    const quiet = new PacketCensus(registry());
    quiet.stage().handle(withTail(), { origin: PacketOrigin.Client, sessionId: 's1' });
    expect(quiet.report().ids[0]?.samples).toBeUndefined();

    const sampling = new PacketCensus(registry(), { sampleTails: true });
    sampling.stage().handle(withTail(), { origin: PacketOrigin.Client, sessionId: 's1' });
    expect(sampling.report().ids[0]?.samples).toEqual(['dead']);
  });

  it('keeps only a handful of samples, not the session', () => {
    const census = new PacketCensus(registry(), { sampleTails: true });
    const stage = census.stage();
    for (let i = 0; i < PacketCensus.MAX_SAMPLES * 3; i += 1) {
      stage.handle(
        new MutablePacket({
          id: 1,
          name: 'MOVE',
          direction: PacketDirection.ClientToServer,
          schema: registry().schemaById(1),
          frame: Buffer.alloc(14),
          fields: {},
          trailing: Buffer.from([i]),
          error: undefined,
        }),
        { origin: PacketOrigin.Client, sessionId: 's1' },
      );
    }

    expect(census.report().ids[0]?.samples).toHaveLength(PacketCensus.MAX_SAMPLES);
  });

  it('does not call a packet conflicting when it travelled as defined', () => {
    const census = new PacketCensus(registry());
    const update = registry().schemaById(2);
    census
      .stage()
      .handle(packet(2, 'UPDATE', update), { origin: PacketOrigin.Server, sessionId: 's1' });

    expect(census.report().ids[0]?.directionConflict).toBeUndefined();
  });

  it('summarises what needs looking at', () => {
    const census = new PacketCensus(registry());
    const stage = census.stage();
    stage.handle(packet(1, 'MOVE', registry().schemaById(1)), {
      origin: PacketOrigin.Client,
      sessionId: 's1',
    });
    stage.handle(packet(99, 'UNKNOWN_99', undefined), {
      origin: PacketOrigin.Server,
      sessionId: 's1',
    });

    expect(census.summary()).toBe(
      '2 packets, 2 distinct ids: 1 undefined, 0 failed to decode, ' +
        '0 with bytes nobody describes, 0 with the wrong direction',
    );
  });
});
