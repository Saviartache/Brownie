import type { MutablePacket } from '@brownie/plugin-api';
import { toError } from '../core/logging/Logger.js';

/** Which side a packet came from. */
export const PacketOrigin = {
  Client: 'client',
  Server: 'server',
} as const;

export type PacketOrigin = (typeof PacketOrigin)[keyof typeof PacketOrigin];

export interface PacketContext {
  readonly origin: PacketOrigin;
  readonly sessionId: string;
}

/**
 * One step a packet passes through.
 *
 * Stages are ordered by the pipeline that holds them, not by whoever registered
 * first. That is the whole reason this type exists: in the reference
 * implementation, state objects and plugins both called `hookPacket`, so
 * whether a plugin saw the world before or after it had been updated depended
 * on the order `index.ts` happened to call `attach()` in.
 */
export interface PipelineStage {
  /** For error attribution and tracing. */
  readonly name: string;
  handle(packet: MutablePacket, context: PacketContext): void;
}

export interface StageFailure {
  readonly stage: string;
  readonly packetName: string;
  readonly error: Error;
  readonly context: PacketContext;
}

/**
 * Runs every stage over a packet, in order, isolating their failures.
 *
 * A stage that throws loses its turn — not the packet, and not the connection.
 * The packet keeps whatever verdict it already had and continues to the next
 * stage, because a plugin crashing is not a reason to stop forwarding the
 * game's traffic.
 */
export class PacketPipeline {
  readonly #stages: readonly PipelineStage[];
  readonly #onFailure: (failure: StageFailure) => void;

  constructor(stages: readonly PipelineStage[], onFailure: (failure: StageFailure) => void) {
    this.#stages = [...stages];
    this.#onFailure = onFailure;
  }

  get stageNames(): readonly string[] {
    return this.#stages.map((stage) => stage.name);
  }

  run(packet: MutablePacket, context: PacketContext): void {
    for (const stage of this.#stages) {
      try {
        stage.handle(packet, context);
      } catch (cause) {
        this.#onFailure({
          stage: stage.name,
          packetName: packet.name,
          error: toError(cause) ?? new Error('stage threw undefined'),
          context,
        });
      }
    }
  }
}
