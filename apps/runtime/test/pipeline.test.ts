import { MutablePacket, Verdict } from '@brownie/plugin-api';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { describe, expect, it } from 'vitest';
import {
  PacketOrigin,
  PacketPipeline,
  type PacketContext,
  type PipelineStage,
  type StageFailure,
} from '../src/pipeline/PacketPipeline.js';

const registry = createBundledRegistry();

function telemetryPacket(): MutablePacket {
  const packet = createPacket(registry, 'TELEPORT');
  packet.fields['objectId'] = 5;
  packet.fields['playerName'] = 'someone';
  return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
}

const CONTEXT: PacketContext = { origin: PacketOrigin.Client, sessionId: 's1' };

function stage(name: string, handle: PipelineStage['handle']): PipelineStage {
  return { name, handle };
}

describe('PacketPipeline', () => {
  it('runs stages in the order it was given, not the order they registered', () => {
    const order: string[] = [];
    const pipeline = new PacketPipeline(
      [
        stage('state', () => order.push('state')),
        stage('core', () => order.push('core')),
        stage('plugins', () => order.push('plugins')),
      ],
      () => undefined,
    );

    pipeline.run(telemetryPacket(), CONTEXT);

    expect(order).toEqual(['state', 'core', 'plugins']);
    expect(pipeline.stageNames).toEqual(['state', 'core', 'plugins']);
  });

  it('lets a stage change a field and records the packet as modified', () => {
    const pipeline = new PacketPipeline(
      [stage('rewrite', (packet) => packet.set('objectId', 99))],
      () => undefined,
    );
    const packet = telemetryPacket();

    pipeline.run(packet, CONTEXT);

    expect(packet.modified).toBe(true);
    expect(packet.number('objectId')).toBe(99);
  });

  it('lets a stage drop a packet', () => {
    const pipeline = new PacketPipeline(
      [stage('block', (packet) => packet.drop())],
      () => undefined,
    );
    const packet = telemetryPacket();

    pipeline.run(packet, CONTEXT);

    expect(packet.verdict).toBe(Verdict.Drop);
  });

  describe('failure isolation', () => {
    it('a throwing stage loses its turn, not the packet', () => {
      const failures: StageFailure[] = [];
      const seen: string[] = [];
      const pipeline = new PacketPipeline(
        [
          stage('first', () => seen.push('first')),
          stage('broken', () => {
            throw new Error('plugin bug');
          }),
          stage('last', () => seen.push('last')),
        ],
        (failure) => failures.push(failure),
      );
      const packet = telemetryPacket();

      expect(() => pipeline.run(packet, CONTEXT)).not.toThrow();

      expect(seen).toEqual(['first', 'last']);
      expect(packet.verdict).toBe(Verdict.Forward);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.stage).toBe('broken');
      expect(failures[0]?.packetName).toBe('TELEPORT');
      expect(failures[0]?.error.message).toBe('plugin bug');
      expect(failures[0]?.context).toEqual(CONTEXT);
    });

    it('keeps a verdict a stage set before a later one threw', () => {
      const pipeline = new PacketPipeline(
        [
          stage('block', (packet) => packet.drop()),
          stage('broken', () => {
            throw new Error('bug');
          }),
        ],
        () => undefined,
      );
      const packet = telemetryPacket();

      pipeline.run(packet, CONTEXT);

      expect(packet.verdict).toBe(Verdict.Drop);
    });

    it('reports a thrown non-Error as an Error', () => {
      const failures: StageFailure[] = [];
      const pipeline = new PacketPipeline(
        [
          stage('rude', () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw 'a string';
          }),
        ],
        (failure) => failures.push(failure),
      );

      pipeline.run(telemetryPacket(), CONTEXT);

      expect(failures[0]?.error).toBeInstanceOf(Error);
      expect(failures[0]?.error.message).toBe('a string');
    });
  });

  it('copies its stage list, so a caller cannot reorder it later', () => {
    const stages = [stage('a', () => undefined)];
    const pipeline = new PacketPipeline(stages, () => undefined);
    stages.push(stage('b', () => undefined));
    expect(pipeline.stageNames).toEqual(['a']);
  });
});
